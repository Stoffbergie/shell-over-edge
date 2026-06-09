const std = @import("std");
const builtin = @import("builtin");

const max_body_bytes = 1024 * 1024;

const Options = struct {
    base_url: []const u8,
    session: []const u8,
};

const HttpResponse = struct {
    status: std.http.Status,
    body: []u8,
    command_id: []const u8 = "",
    cwd_b64: []const u8 = "",
    timeout_seconds: u32 = 30,

    fn deinit(response: HttpResponse, allocator: std.mem.Allocator) void {
        allocator.free(response.body);
        if (response.command_id.len > 0) allocator.free(response.command_id);
        if (response.cwd_b64.len > 0) allocator.free(response.cwd_b64);
    }
};

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;

    const options = try parseOptions(allocator, init.minimal.args);
    defer allocator.free(options.base_url);
    defer allocator.free(options.session);

    var client: std.http.Client = .{ .allocator = allocator, .io = init.io };
    defer client.deinit();

    try printLine(init.io, allocator, "Shell Over Edge native agent");
    try printLine(init.io, allocator, options.session);

    const cwd = try currentDirectory(init.io, allocator);
    defer allocator.free(cwd);
    const hello = try request(allocator, &client, .POST, options.base_url, options.session, "/hello", cwd, &.{});
    defer hello.deinit(allocator);

    while (true) {
        const next = request(allocator, &client, .GET, options.base_url, options.session, "/next", null, &.{}) catch {
            try sleepSeconds(init.io, 1);
            continue;
        };
        defer next.deinit(allocator);

        switch (next.status) {
            .no_content => continue,
            .ok => {},
            .gone, .not_found, .unauthorized => {
                if (next.body.len > 0) try printLine(init.io, allocator, next.body);
                break;
            },
            else => {
                try sleepSeconds(init.io, 1);
                continue;
            },
        }

        if (next.command_id.len == 0) continue;
        const run_result = try runCommand(allocator, init.io, next.body, next.cwd_b64, next.timeout_seconds);
        defer allocator.free(run_result.output);

        const result_path = try std.fmt.allocPrint(allocator, "/result/{s}?exit={d}", .{ next.command_id, run_result.exit_code });
        defer allocator.free(result_path);
        const posted = request(allocator, &client, .POST, options.base_url, options.session, result_path, run_result.output, &.{}) catch continue;
        defer posted.deinit(allocator);
    }

    const ended = request(allocator, &client, .POST, options.base_url, options.session, "/end", "", &.{}) catch return;
    defer ended.deinit(allocator);
}

fn parseOptions(allocator: std.mem.Allocator, process_args: std.process.Args) !Options {
    var args = try std.process.Args.Iterator.initAllocator(process_args, allocator);
    defer args.deinit();
    _ = args.next();

    var base_url: ?[]const u8 = null;
    var session: ?[]const u8 = null;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--base-url")) {
            base_url = try allocator.dupe(u8, args.next() orelse return error.MissingBaseUrl);
        } else if (std.mem.eql(u8, arg, "--session")) {
            session = try allocator.dupe(u8, args.next() orelse return error.MissingSession);
        }
    }

    return .{
        .base_url = base_url orelse return error.MissingBaseUrl,
        .session = session orelse return error.MissingSession,
    };
}

fn request(
    allocator: std.mem.Allocator,
    client: *std.http.Client,
    method: std.http.Method,
    base_url: []const u8,
    session: []const u8,
    suffix: []const u8,
    payload: ?[]const u8,
    extra_headers: []const std.http.Header,
) !HttpResponse {
    const url = try std.fmt.allocPrint(allocator, "{s}/api/sessions/{s}{s}", .{ trimRightSlash(base_url), session, suffix });
    defer allocator.free(url);

    const uri = try std.Uri.parse(url);
    var req = try client.request(method, uri, .{
        .headers = .{
            .user_agent = .{ .override = "soe-agent/0" },
            .content_type = .{ .override = "application/octet-stream" },
        },
        .extra_headers = extra_headers,
    });
    defer req.deinit();

    if (payload) |body| {
        req.transfer_encoding = .{ .content_length = body.len };
        var writer = try req.sendBodyUnflushed(&.{});
        try writer.writer.writeAll(body);
        try writer.end();
        try req.connection.?.flush();
    } else {
        try req.sendBodiless();
    }

    var redirect_buffer: [8192]u8 = undefined;
    var response = try req.receiveHead(&redirect_buffer);
    const body = try readResponseBody(allocator, &response);

    var command_id: []const u8 = "";
    var cwd_b64: []const u8 = "";
    var timeout_seconds: u32 = 30;
    var headers = response.head.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "X-Command-Id")) {
            command_id = try allocator.dupe(u8, header.value);
        } else if (std.ascii.eqlIgnoreCase(header.name, "X-Command-Cwd-Base64")) {
            cwd_b64 = try allocator.dupe(u8, header.value);
        } else if (std.ascii.eqlIgnoreCase(header.name, "X-Command-Timeout")) {
            timeout_seconds = std.fmt.parseInt(u32, header.value, 10) catch 30;
        }
    }

    return .{
        .status = response.head.status,
        .body = body,
        .command_id = command_id,
        .cwd_b64 = cwd_b64,
        .timeout_seconds = timeout_seconds,
    };
}

fn readResponseBody(allocator: std.mem.Allocator, response: *std.http.Client.Response) ![]u8 {
    var aw: std.Io.Writer.Allocating = .init(allocator);
    defer aw.deinit();
    var transfer_buffer: [512]u8 = undefined;
    var decompress: std.http.Decompress = undefined;
    const reader = response.readerDecompressing(&transfer_buffer, &decompress, &.{});
    _ = try reader.streamRemaining(&aw.writer);
    if (aw.written().len > max_body_bytes) return error.BodyTooLarge;
    return try allocator.dupe(u8, aw.written());
}

const CommandResult = struct {
    output: []u8,
    exit_code: u8,
};

fn runCommand(allocator: std.mem.Allocator, io: std.Io, command: []const u8, cwd_b64: []const u8, timeout_seconds: u32) !CommandResult {
    const cwd = try decodeBase64(allocator, cwd_b64);
    defer allocator.free(cwd);

    const argv = switch (builtin.os.tag) {
        .windows => &[_][]const u8{ "cmd.exe", "/C", command },
        else => &[_][]const u8{ "sh", "-c", command },
    };

    const result = std.process.run(allocator, io, .{
        .argv = argv,
        .cwd = if (cwd.len > 0) .{ .path = cwd } else .inherit,
        .stdout_limit = .limited(max_body_bytes / 2),
        .stderr_limit = .limited(max_body_bytes / 2),
        .timeout = .{ .duration = clockDuration(timeout_seconds) },
    }) catch |err| switch (err) {
        error.Timeout => return .{ .output = try allocator.dupe(u8, "Command timed out\n"), .exit_code = 124 },
        else => return err,
    };
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    const output = try std.mem.concat(allocator, u8, &.{ result.stdout, result.stderr });
    const exit_code: u8 = switch (result.term) {
        .exited => |code| code,
        else => 1,
    };
    return .{ .output = output, .exit_code = exit_code };
}

fn decodeBase64(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    if (value.len == 0) return allocator.dupe(u8, "");
    const decoder = std.base64.standard.Decoder;
    const size = try decoder.calcSizeForSlice(value);
    const output = try allocator.alloc(u8, size);
    try decoder.decode(output, value);
    return output;
}

fn currentDirectory(io: std.Io, allocator: std.mem.Allocator) ![]u8 {
    return std.process.currentPathAlloc(io, allocator);
}

fn trimRightSlash(value: []const u8) []const u8 {
    if (value.len > 0 and value[value.len - 1] == '/') return value[0 .. value.len - 1];
    return value;
}

fn printLine(io: std.Io, allocator: std.mem.Allocator, value: []const u8) !void {
    const line = try std.fmt.allocPrint(allocator, "{s}\n", .{value});
    defer allocator.free(line);
    var buffer: [1024]u8 = undefined;
    var writer = std.Io.File.stdout().writer(io, &buffer);
    try writer.interface.writeAll(line);
    try writer.interface.flush();
}

fn sleepSeconds(io: std.Io, seconds: i64) !void {
    try std.Io.sleep(io, .fromSeconds(seconds), .awake);
}

fn clockDuration(seconds: u32) std.Io.Clock.Duration {
    return .{
        .raw = .fromSeconds(seconds),
        .clock = .awake,
    };
}
