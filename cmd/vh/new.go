package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
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
	newCmd.Flags().BoolVar(&newInteractive, "interactive", false, "attach TTY for interactive use")

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

	if args.Interactive {
		return runNewInteractive(client, args)
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

func runNewInteractive(client *internal.Client, args internal.NewArgs) error {
	result, err := client.NewInteractive(args)
	if err != nil {
		return err
	}

	_, _ = fmt.Fprintf(os.Stdout, "starting interactive session for agent '%s'\n", result.Agent.Name)

	// Build the command from the daemon's response.
	cmd := exec.Command(result.Command, result.Args...)
	cmd.Dir = result.Dir
	cmd.Env = result.Env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		// Notify daemon of failure.
		_ = client.NotifyExit(result.Agent.Name, 1)
		return fmt.Errorf("start interactive process: %w", err)
	}

	// Notify daemon of the PID.
	if err := client.NotifyStart(result.Agent.Name, cmd.Process.Pid); err != nil {
		// Best effort: kill the process if we can't notify.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return fmt.Errorf("notify daemon of start: %w", err)
	}

	// Wait for the process to exit.
	waitErr := cmd.Wait()
	exitCode := 0
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	// Notify daemon of exit.
	_ = client.NotifyExit(result.Agent.Name, exitCode)

	if exitCode != 0 {
		os.Exit(exitCode)
	}
	return nil
}
