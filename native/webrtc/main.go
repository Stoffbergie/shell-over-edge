package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

const defaultTTLSeconds = 120

type options struct {
	mode           string
	baseURL        string
	session        string
	body           string
	cwd            string
	timeoutSeconds int
	connectSeconds int
}

type commandMessage struct {
	ID             string `json:"id"`
	Body           string `json:"body"`
	Cwd            string `json:"cwd,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

type resultMessage struct {
	ID       string `json:"id"`
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
}

type signalPayload struct {
	Role       string     `json:"role"`
	Transport  string     `json:"transport"`
	Data       signalData `json:"data"`
	Priority   int        `json:"priority"`
	TTLSeconds int        `json:"ttlSeconds"`
}

type signalList struct {
	Signals []signal `json:"signals"`
}

type signal struct {
	ID        string     `json:"id"`
	Role      string     `json:"role"`
	Transport string     `json:"transport"`
	Data      signalData `json:"data"`
}

type signalData struct {
	Kind          string  `json:"kind,omitempty"`
	ConnectionID  string  `json:"connectionId,omitempty"`
	Type          string  `json:"type,omitempty"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        string  `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

type icePayload struct {
	ICEServers []iceServer `json:"iceServers"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type httpClient interface {
	Do(*http.Request) (*http.Response, error)
}

type sessionTerminalError struct {
	status string
}

func (err sessionTerminalError) Error() string {
	return fmt.Sprintf("session closed: %s", err.status)
}

func main() {
	opts, err := parseOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	ctx := context.Background()
	switch opts.mode {
	case "agent":
		if err := runAgent(ctx, http.DefaultClient, opts); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "send":
		code, err := runSender(ctx, http.DefaultClient, opts)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(code)
	default:
		fmt.Fprintln(os.Stderr, "usage: soe-webrtc agent|send --base-url URL --session CODE")
		os.Exit(2)
	}
}

func parseOptions(args []string) (options, error) {
	if len(args) == 0 {
		return options{}, errors.New("missing mode")
	}
	opts := options{mode: args[0], timeoutSeconds: 30, connectSeconds: 10}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.baseURL, "base-url", "", "")
	fs.StringVar(&opts.session, "session", "", "")
	fs.StringVar(&opts.body, "body", "", "")
	fs.StringVar(&opts.cwd, "cwd", "", "")
	fs.IntVar(&opts.timeoutSeconds, "timeout", 30, "")
	fs.IntVar(&opts.timeoutSeconds, "timeout-seconds", 30, "")
	fs.IntVar(&opts.connectSeconds, "connect-timeout", 10, "")
	if err := fs.Parse(args[1:]); err != nil {
		return options{}, err
	}
	opts.baseURL = strings.TrimRight(opts.baseURL, "/")
	if opts.baseURL == "" {
		return options{}, errors.New("missing --base-url")
	}
	if opts.session == "" {
		return options{}, errors.New("missing --session")
	}
	if opts.mode == "send" && opts.body == "" {
		remaining := fs.Args()
		if len(remaining) > 0 {
			opts.body = strings.Join(remaining, " ")
		}
	}
	if opts.mode == "send" && strings.TrimSpace(opts.body) == "" {
		return options{}, errors.New("missing --body")
	}
	if opts.timeoutSeconds < 1 {
		opts.timeoutSeconds = 1
	}
	if opts.connectSeconds < 1 {
		opts.connectSeconds = 1
	}
	return opts, nil
}

func runSender(ctx context.Context, client httpClient, opts options) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(opts.connectSeconds+opts.timeoutSeconds+3)*time.Second)
	defer cancel()

	connectionID := randomID()
	pc, err := newPeerConnection(ctx, client, opts)
	if err != nil {
		return 1, err
	}
	defer pc.Close()
	if err := publishCandidates(ctx, client, opts, pc, "client", connectionID); err != nil {
		return 1, err
	}

	opened := make(chan struct{})
	result := make(chan resultMessage, 1)
	commandID := randomID()
	channel, err := pc.CreateDataChannel("soe", nil)
	if err != nil {
		return 1, err
	}
	channel.OnOpen(func() {
		payload, _ := json.Marshal(commandMessage{
			ID:             commandID,
			Body:           opts.body,
			Cwd:            opts.cwd,
			TimeoutSeconds: opts.timeoutSeconds,
		})
		_ = channel.SendText(string(payload))
		close(opened)
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		var payload resultMessage
		if json.Unmarshal(message.Data, &payload) == nil && payload.ID == commandID {
			result <- payload
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return 1, err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return 1, err
	}
	if err := publishDescription(ctx, client, opts, "client", connectionID, offer); err != nil {
		return 1, err
	}
	if err := waitForAnswer(ctx, client, opts, pc, connectionID); err != nil {
		return 1, err
	}

	answerSeen := map[string]bool{}
	go pollCandidates(ctx, client, opts, pc, "agent", connectionID, answerSeen)

	select {
	case <-opened:
	case <-ctx.Done():
		return 1, errors.New("timed out opening WebRTC data channel")
	}
	select {
	case payload := <-result:
		fmt.Print(payload.Output)
		return payload.ExitCode, nil
	case <-time.After(time.Duration(opts.timeoutSeconds+1) * time.Second):
		return 1, errors.New("timed out waiting for WebRTC command result")
	case <-ctx.Done():
		return 1, errors.New("timed out waiting for WebRTC command result")
	}
}

func runAgent(ctx context.Context, client httpClient, opts options) error {
	seen := map[string]bool{}
	for {
		if err := acceptAgentConnection(ctx, client, opts, seen); err != nil {
			if isSessionTerminal(err) {
				return nil
			}
			if ctx.Err() != nil {
				return err
			}
		}
	}
}

func acceptAgentConnection(ctx context.Context, client httpClient, opts options, seen map[string]bool) error {
	pc, err := newPeerConnection(ctx, client, opts)
	if err != nil {
		return err
	}
	keepPeer := false
	defer func() {
		if !keepPeer {
			_ = pc.Close()
		}
	}()

	done := make(chan struct{})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			var command commandMessage
			if json.Unmarshal(message.Data, &command) != nil || strings.TrimSpace(command.Body) == "" {
				return
			}
			result := executeCommand(command)
			payload, _ := json.Marshal(result)
			_ = channel.SendText(string(payload))
			go closeChannelSoon(channel, done)
		})
		channel.OnClose(func() {
			closeDone(done)
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
			closeDone(done)
		}
	})

	connectionID, err := waitForOffer(ctx, client, opts, pc, seen)
	if err != nil {
		return err
	}
	if err := publishCandidates(ctx, client, opts, pc, "agent", connectionID); err != nil {
		return err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return err
	}
	if err := publishDescription(ctx, client, opts, "agent", connectionID, answer); err != nil {
		return err
	}
	connectionCtx, cancel := context.WithCancel(ctx)
	go pollCandidates(connectionCtx, client, opts, pc, "client", connectionID, map[string]bool{})
	go func() {
		<-done
		cancel()
		_ = pc.Close()
	}()
	keepPeer = true
	return nil
}

func newPeerConnection(ctx context.Context, client httpClient, opts options) (*webrtc.PeerConnection, error) {
	ice, err := loadICEServers(ctx, client, opts)
	if err != nil {
		return nil, err
	}
	return webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
}

func publishCandidates(ctx context.Context, client httpClient, opts options, pc *webrtc.PeerConnection, role string, connectionID string) error {
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		init := candidate.ToJSON()
		_ = publishSignal(ctx, client, opts, signalPayload{
			Role:       role,
			Transport:  "webrtc",
			Priority:   1,
			TTLSeconds: defaultTTLSeconds,
			Data: signalData{
				Kind:          "candidate",
				ConnectionID:  connectionID,
				Candidate:     init.Candidate,
				SDPMid:        stringValue(init.SDPMid),
				SDPMLineIndex: init.SDPMLineIndex,
			},
		})
	})
	return nil
}

func waitForOffer(ctx context.Context, client httpClient, opts options, pc *webrtc.PeerConnection, seen map[string]bool) (string, error) {
	deadline := time.Now().Add(time.Duration(opts.connectSeconds) * time.Second)
	for time.Now().Before(deadline) {
		signals, err := listSignals(ctx, client, opts, "client")
		if err != nil {
			return "", err
		}
		for _, item := range signals {
			if item.Transport != "webrtc" {
				continue
			}
			if signalKind(item.Data) == "offer" && item.Data.ConnectionID != "" {
				if seen[item.ID] {
					continue
				}
				offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: item.Data.SDP}
				if err := pc.SetRemoteDescription(offer); err != nil {
					return "", err
				}
				seen[item.ID] = true
				return item.Data.ConnectionID, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", errors.New("timed out waiting for WebRTC offer")
}

func waitForAnswer(ctx context.Context, client httpClient, opts options, pc *webrtc.PeerConnection, connectionID string) error {
	deadline := time.Now().Add(time.Duration(opts.connectSeconds) * time.Second)
	for time.Now().Before(deadline) {
		signals, err := listSignals(ctx, client, opts, "agent")
		if err != nil {
			return err
		}
		for _, item := range signals {
			if item.Transport == "webrtc" && item.Data.ConnectionID == connectionID && signalKind(item.Data) == "answer" {
				return pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: item.Data.SDP})
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("timed out waiting for WebRTC answer")
}

func pollCandidates(ctx context.Context, client httpClient, opts options, pc *webrtc.PeerConnection, role string, connectionID string, seen map[string]bool) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		signals, err := listSignals(ctx, client, opts, role)
		if err == nil {
			for _, item := range signals {
				if seen[item.ID] {
					continue
				}
				if item.Transport != "webrtc" || item.Data.ConnectionID != connectionID || signalKind(item.Data) != "candidate" || item.Data.Candidate == "" {
					continue
				}
				seen[item.ID] = true
				_ = pc.AddICECandidate(webrtc.ICECandidateInit{
					Candidate:     item.Data.Candidate,
					SDPMid:        pointerString(item.Data.SDPMid),
					SDPMLineIndex: item.Data.SDPMLineIndex,
				})
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func publishDescription(ctx context.Context, client httpClient, opts options, role string, connectionID string, description webrtc.SessionDescription) error {
	return publishSignal(ctx, client, opts, signalPayload{
		Role:       role,
		Transport:  "webrtc",
		Priority:   1,
		TTLSeconds: defaultTTLSeconds,
		Data: signalData{
			Kind:         strings.ToLower(description.Type.String()),
			ConnectionID: connectionID,
			SDP:          description.SDP,
		},
	})
}

func publishSignal(ctx context.Context, client httpClient, opts options, payload signalPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/sessions/%s/signals", opts.baseURL, opts.session), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1000))
		return fmt.Errorf("publish signal failed: %s %s", response.Status, strings.TrimSpace(string(data)))
	}
	return nil
}

func listSignals(ctx context.Context, client httpClient, opts options, role string) ([]signal, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/sessions/%s/signals?role=%s", opts.baseURL, opts.session, role), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1000))
		if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusUnauthorized {
			return nil, sessionTerminalError{status: response.Status}
		}
		return nil, fmt.Errorf("list signals failed: %s %s", response.Status, strings.TrimSpace(string(data)))
	}
	var payload signalList
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Signals, nil
}

func loadICEServers(ctx context.Context, client httpClient, opts options) ([]webrtc.ICEServer, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/sessions/%s/ice", opts.baseURL, opts.session), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1000))
		return nil, fmt.Errorf("ice request failed: %s %s", response.Status, strings.TrimSpace(string(data)))
	}
	var payload icePayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	output := make([]webrtc.ICEServer, 0, len(payload.ICEServers))
	for _, server := range payload.ICEServers {
		output = append(output, webrtc.ICEServer{
			URLs:       server.URLs,
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	if len(output) == 0 {
		output = append(output, webrtc.ICEServer{URLs: []string{"stun:stun.cloudflare.com:3478"}})
	}
	return output, nil
}

func executeCommand(command commandMessage) resultMessage {
	timeoutSeconds := command.TimeoutSeconds
	if timeoutSeconds < 1 {
		timeoutSeconds = 30
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/C", command.Body)
	} else {
		cmd = exec.Command("sh", "-c", command.Body)
	}
	if command.Cwd != "" {
		cmd.Dir = command.Cwd
	}
	configureCommand(cmd)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		return resultMessage{ID: command.ID, Output: err.Error(), ExitCode: 1}
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		killCommand(cmd)
		err = <-done
		return resultMessage{ID: command.ID, Output: fmt.Sprintf("Command timed out after %d seconds\n", timeoutSeconds), ExitCode: 124}
	}
	exitCode := 0
	if err != nil {
		exitCode = 1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
	}
	return resultMessage{ID: command.ID, Output: output.String(), ExitCode: exitCode}
}

func signalKind(data signalData) string {
	if data.Kind != "" {
		return data.Kind
	}
	return data.Type
}

func pointerString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func randomID() string {
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), rand.Int63())
}

func isSessionTerminal(err error) bool {
	var terminal sessionTerminalError
	return errors.As(err, &terminal)
}

func closeDone(done chan struct{}) {
	select {
	case <-done:
	default:
		close(done)
	}
}

func closeChannelSoon(channel *webrtc.DataChannel, done chan struct{}) {
	time.Sleep(250 * time.Millisecond)
	_ = channel.Close()
	closeDone(done)
}
