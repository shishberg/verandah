package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var stopCmd = &cobra.Command{
	Use:   "stop <name>",
	Short: "Stop a running agent",
	RunE:  runStop,
}

var stopAll bool

func init() {
	stopCmd.Flags().BoolVar(&stopAll, "all", false, "stop all running agents")

	rootCmd.AddCommand(stopCmd)
}

func runStop(_ *cobra.Command, args []string) error {
	if !stopAll && len(args) == 0 {
		return fmt.Errorf("requires an agent name or --all")
	}

	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	if stopAll {
		result, err := client.StopAll()
		if err != nil {
			return err
		}
		if len(result.Agents) == 0 {
			_, _ = fmt.Fprintln(os.Stdout, "no running agents")
		} else {
			for _, a := range result.Agents {
				_, _ = fmt.Fprintf(os.Stdout, "stopped agent '%s'\n", a.Name)
			}
		}
		return nil
	}

	name := args[0]
	result, err := client.Stop(name)
	if err != nil {
		return err
	}

	_, _ = fmt.Fprintln(os.Stdout, result.Message)
	return nil
}
