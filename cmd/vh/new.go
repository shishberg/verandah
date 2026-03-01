package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var newCmd = &cobra.Command{
	Use:   "new",
	Short: "Create a new agent, optionally starting it with a prompt",
	RunE:  runNew,
}

var (
	newName           string
	newPrompt         string
	newCWD            string
	newModel          string
	newPermissionMode string
	newMaxTurns       int
	newAllowedTools   string
	newInteractive    bool
)

func init() {
	newCmd.Flags().StringVar(&newName, "name", "", "agent name (random if omitted)")
	newCmd.Flags().StringVar(&newPrompt, "prompt", "", "initial prompt (use - for stdin)")
	newCmd.Flags().StringVar(&newCWD, "cwd", "", "working directory (defaults to current directory)")
	newCmd.Flags().StringVar(&newModel, "model", "", "model to use")
	newCmd.Flags().StringVar(&newPermissionMode, "permission-mode", "", "permission mode")
	newCmd.Flags().IntVar(&newMaxTurns, "max-turns", 0, "max agentic turns")
	newCmd.Flags().StringVar(&newAllowedTools, "allowed-tools", "", "allowed tools")
	newCmd.Flags().BoolVar(&newInteractive, "interactive", false, "attach TTY for interactive use (stub)")

	rootCmd.AddCommand(newCmd)
}

func runNew(cmd *cobra.Command, _ []string) error {
	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	args := internal.NewArgs{
		Name:        newName,
		Interactive: newInteractive,
	}

	// Resolve --prompt.
	if cmd.Flags().Changed("prompt") {
		prompt := newPrompt
		if prompt == "-" {
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("read stdin: %w", err)
			}
			prompt = string(data)
		}
		args.Prompt = &prompt
	}

	// Resolve --cwd.
	if newCWD != "" {
		args.CWD = newCWD
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("get working directory: %w", err)
		}
		args.CWD = cwd
	}

	// Set optional flags only if provided.
	if cmd.Flags().Changed("model") {
		args.Model = &newModel
	}
	if cmd.Flags().Changed("permission-mode") {
		args.PermissionMode = &newPermissionMode
	}
	if cmd.Flags().Changed("max-turns") {
		args.MaxTurns = &newMaxTurns
	}
	if cmd.Flags().Changed("allowed-tools") {
		args.AllowedTools = &newAllowedTools
	}

	agent, err := client.New(args)
	if err != nil {
		return err
	}

	if agent.Status == "running" {
		_, _ = fmt.Fprintf(os.Stdout, "started agent '%s'\n", agent.Name)
	} else {
		_, _ = fmt.Fprintf(os.Stdout, "created agent '%s'\n", agent.Name)
	}

	return nil
}
