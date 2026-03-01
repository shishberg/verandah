package main

import (
	"os"
	"path/filepath"
)

// resolveVHHome returns the VH_HOME directory, reading from the environment
// variable VH_HOME or falling back to ~/.local/verandah/.
func resolveVHHome() string {
	if v := os.Getenv("VH_HOME"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "verandah")
}
