package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/shishberg/verandah/internal"
	"github.com/spf13/cobra"
)

var idleTimeout time.Duration

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Run the daemon in the foreground",
	RunE: func(cmd *cobra.Command, args []string) error {
		vhHome := resolveVHHome()

		// Ensure VH_HOME directory exists.
		if err := os.MkdirAll(vhHome, 0o755); err != nil {
			return fmt.Errorf("create VH_HOME: %w", err)
		}

		d, err := internal.NewDaemon(vhHome)
		if err != nil {
			return err
		}

		d.SetIdleTimeout(idleTimeout)

		socketPath := filepath.Join(vhHome, "vh.sock")
		if err := d.Start(socketPath); err != nil {
			return err
		}

		// Wait for shutdown signal or idle timeout.
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

		select {
		case <-sigCh:
		case <-d.Done():
		}

		return d.Shutdown()
	},
}

func init() {
	daemonCmd.Flags().DurationVar(&idleTimeout, "idle-timeout", 5*time.Minute, "shut down after this duration of inactivity (0 disables)")
	rootCmd.AddCommand(daemonCmd)
}
