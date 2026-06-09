const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSmall });

    const agent = b.addExecutable(.{
        .name = "soe-agent",
        .root_module = b.createModule(.{
            .root_source_file = b.path("native/agent/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(agent);

    const run = b.addRunArtifact(agent);
    if (b.args) |args| run.addArgs(args);

    const run_step = b.step("run-agent", "Run the native agent");
    run_step.dependOn(&run.step);
}
