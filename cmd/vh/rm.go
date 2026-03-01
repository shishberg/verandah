package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var rmCmd = &cobra.Command{
	Use:   "rm <name>",
	Short: "Remove an agent",
	Args:  cobra.ExactArgs(1),
	RunE:  runRm,
}

var rmForce bool

func init() {
	rmCmd.Flags().BoolVar(&rmForce, "force", false, "stop and remove a running agent")

	rootCmd.AddCommand(rmCmd)
}

func runRm(_ *cobra.Command, args []string) error {
	name := args[0]

	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	if err := client.Remove(name, rmForce); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(os.Stdout, "removed agent '%s'\n", name)
	return nil
}
