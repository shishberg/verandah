package internal

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
)

// Client connects to the daemon over a unix socket.
type Client struct {
	socketPath string
}

// NewClient creates a Client that will connect to the given unix socket.
func NewClient(socketPath string) *Client {
	return &Client{socketPath: socketPath}
}

// Send sends a request to the daemon and returns the response.
// Each call opens a new connection, sends one request, reads one response,
// and closes the connection.
func (c *Client) Send(req Request) (Response, error) {
	conn, err := net.Dial("unix", c.socketPath)
	if err != nil {
		return Response{}, fmt.Errorf("connect to daemon: %w", err)
	}
	defer func() { _ = conn.Close() }()

	// Encode the request as JSON + newline.
	data, err := json.Marshal(req)
	if err != nil {
		return Response{}, fmt.Errorf("marshal request: %w", err)
	}
	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		return Response{}, fmt.Errorf("write request: %w", err)
	}

	// Read the response line.
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return Response{}, fmt.Errorf("read response: %w", err)
		}
		return Response{}, fmt.Errorf("read response: unexpected EOF")
	}

	var resp Response
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return Response{}, fmt.Errorf("unmarshal response: %w", err)
	}

	if !resp.OK {
		return resp, fmt.Errorf("daemon error: %s", resp.Error)
	}

	return resp, nil
}

// Ping sends a ping request to the daemon and returns an error if the
// daemon is not reachable or responds with an error.
func (c *Client) Ping() error {
	_, err := c.Send(Request{Command: "ping"})
	return err
}
