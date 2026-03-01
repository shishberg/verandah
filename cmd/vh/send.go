package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var sendCmd = &cobra.Command{
	Use:   "send <name> <message>",
	Short: "Send a message to an agent",
	Args:  cobra.ExactArgs(2),
	RunE:  runSend,
}

func init() {
	rootCmd.AddCommand(sendCmd)
}

func runSend(_ *cobra.Command, args []string) error {
	name := args[0]
	message := args[1]

	if message == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}
		message = string(data)
	}

	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	if _, err := client.SendMessage(name, message); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(os.Stdout, "message sent to '%s'\n", name)
	return nil
}
