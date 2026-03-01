package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var logsCmd = &cobra.Command{
	Use:   "logs <name>",
	Short: "Tail an agent's output log",
	Args:  cobra.ExactArgs(1),
	RunE:  runLogs,
}

var (
	logsFollow   bool
	logsNoFollow bool
	logsLines    int
)

func init() {
	logsCmd.Flags().BoolVarP(&logsFollow, "follow", "f", true, "follow the log (like tail -f)")
	logsCmd.Flags().BoolVar(&logsNoFollow, "no-follow", false, "print current log contents and exit")
	logsCmd.Flags().IntVarP(&logsLines, "lines", "n", 50, "number of lines to show initially")

	rootCmd.AddCommand(logsCmd)
}

func runLogs(_ *cobra.Command, args []string) error {
	name := args[0]

	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	logPath, err := client.LogPath(name)
	if err != nil {
		return err
	}

	// Check if log file exists.
	if _, err := os.Stat(logPath); os.IsNotExist(err) {
		_, _ = fmt.Fprintf(os.Stdout, "no logs for agent '%s'\n", name)
		return nil
	}

	// Read and print the last N lines.
	data, err := os.ReadFile(logPath)
	if err != nil {
		return fmt.Errorf("read log file: %w", err)
	}

	lines := splitLines(data)
	start := 0
	if len(lines) > logsLines {
		start = len(lines) - logsLines
	}
	for _, line := range lines[start:] {
		_, _ = fmt.Fprintln(os.Stdout, line)
	}

	// Determine follow mode: --no-follow overrides --follow.
	follow := logsFollow && !logsNoFollow
	if !follow {
		return nil
	}

	// Follow mode: keep reading new data.
	offset := int64(len(data))
	return tailFollow(logPath, offset)
}

// splitLines splits data into lines, dropping the trailing empty element
// if the data ends with a newline.
func splitLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}

	var lines []string
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, string(data[start:i]))
			start = i + 1
		}
	}
	// If there's trailing content without a newline, include it.
	if start < len(data) {
		lines = append(lines, string(data[start:]))
	}
	return lines
}

// tailFollow reads new data from the file starting at offset, printing it
// to stdout. It polls every 100ms and exits on SIGINT.
func tailFollow(path string, offset int64) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open log for follow: %w", err)
	}
	defer func() { _ = f.Close() }()

	if _, err := f.Seek(offset, 0); err != nil {
		return fmt.Errorf("seek log file: %w", err)
	}

	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
			n, _ := f.Read(buf)
			if n > 0 {
				_, _ = os.Stdout.Write(buf[:n])
			} else {
				time.Sleep(100 * time.Millisecond)
			}
		}
	}
}
