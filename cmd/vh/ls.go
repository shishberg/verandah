package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"text/tabwriter"
	"time"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var lsCmd = &cobra.Command{
	Use:   "ls",
	Short: "List all tracked agents",
	RunE:  runLs,
}

var (
	lsJSON   bool
	lsStatus string
)

func init() {
	lsCmd.Flags().BoolVar(&lsJSON, "json", false, "output as JSON")
	lsCmd.Flags().StringVar(&lsStatus, "status", "", "filter by status")

	rootCmd.AddCommand(lsCmd)
}

func runLs(_ *cobra.Command, _ []string) error {
	vhHome := resolveVHHome()
	if err := os.MkdirAll(vhHome, 0o755); err != nil {
		return fmt.Errorf("create VH_HOME: %w", err)
	}

	socketPath := filepath.Join(vhHome, "vh.sock")
	client := internal.NewClient(socketPath, vhHome)

	agents, err := client.List(lsStatus)
	if err != nil {
		return err
	}

	if lsJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(agents)
	}

	// Table output.
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(w, "NAME\tSTATUS\tMODEL\tCWD\tUPTIME")
	for _, a := range agents {
		model := ""
		if a.Model != nil {
			model = *a.Model
		}
		uptime := "\u2014" // em-dash
		if a.Status == "running" {
			uptime = formatUptime(time.Since(a.CreatedAt))
		}
		_, _ = fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", a.Name, a.Status, model, a.CWD, uptime)
	}
	return w.Flush()
}

// formatUptime formats a duration as a human-readable string like "12m", "2h", "3d".
func formatUptime(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
