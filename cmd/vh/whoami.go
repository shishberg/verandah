package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Report the current agent's metadata",
	RunE:  runWhoami,
}

var (
	whoamiJSON  bool
	whoamiCheck bool
)

func init() {
	whoamiCmd.Flags().BoolVar(&whoamiJSON, "json", false, "output as JSON object")
	whoamiCmd.Flags().BoolVar(&whoamiCheck, "check", false, "exit 0 if inside a vh agent, 1 otherwise")

	rootCmd.AddCommand(whoamiCmd)
}

func runWhoami(_ *cobra.Command, _ []string) error {
	name := os.Getenv("VH_AGENT_NAME")

	if whoamiCheck {
		if name != "" {
			os.Exit(0)
		}
		os.Exit(1)
		return nil // unreachable, but satisfies compiler
	}

	if name == "" {
		return fmt.Errorf("not running inside a vh-managed agent")
	}

	vhHome := resolveVHHome()
	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	agent, err := client.Whoami(name)
	if err != nil {
		return err
	}

	if whoamiJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(agent)
	}

	// Human-readable output.
	fmt.Printf("NAME:        %s\n", agent.Name)
	fmt.Printf("STATUS:      %s\n", agent.Status)
	if agent.Model != nil {
		fmt.Printf("MODEL:       %s\n", *agent.Model)
	}
	fmt.Printf("CWD:         %s\n", agent.CWD)
	if agent.SessionID != nil {
		fmt.Printf("SESSION_ID:  %s\n", *agent.SessionID)
	}
	fmt.Printf("CREATED_AT:  %s\n", agent.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"))

	return nil
}
