// Command dev runs the server from source for development:
//
//	go run ./dev
//
// It starts the dependencies (dev/docker-compose.yml), builds and runs the
// server with the settings in dev/env, and rebuilds and restarts it whenever
// a .go file under cmd/ or internal/ changes. Run `npm run dev` in web/ next
// to it for the panel with hot reload.
package main

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "dev:", err)
		os.Exit(1)
	}
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

// loadEnv reads KEY=VALUE lines. Variables already set in the environment win,
// so a single setting can be overridden for one run.
func loadEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}

// newest returns the latest modification time of any Go source file.
func newest() time.Time {
	var t time.Time
	for _, root := range []string{"cmd", "internal"} {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			// The embedded panel build changes on every `npm run build`;
			// that is not a reason to restart during UI work.
			if d.IsDir() && d.Name() == "dist" {
				return filepath.SkipDir
			}
			if !d.IsDir() && strings.HasSuffix(p, ".go") {
				if fi, err := d.Info(); err == nil && fi.ModTime().After(t) {
					t = fi.ModTime()
				}
			}
			return nil
		})
	}
	return t
}

func main() {
	if _, err := os.Stat("go.mod"); err != nil {
		must(fmt.Errorf("run from the repository root: go run ./dev"))
	}
	must(os.MkdirAll(".dev/data/whitepages", 0o755))
	must(loadEnv("dev/env"))
	fmt.Println("dev: starting dependencies")
	must(run("docker", "compose", "-f", "dev/docker-compose.yml", "up", "-d"))

	bin := filepath.Join(".dev", "tds")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)

	for {
		built := newest()
		var server *exec.Cmd
		start := time.Now()
		if err := run("go", "build", "-o", bin, "./cmd/tds"); err != nil {
			fmt.Println("dev: build failed, waiting for a change")
		} else {
			server = exec.Command(bin)
			server.Stdout, server.Stderr = os.Stdout, os.Stderr
			must(server.Start())
			fmt.Printf("dev: server started (built in %s) — panel http://%s, traffic http://%s\n",
				time.Since(start).Round(100*time.Millisecond), os.Getenv("TDS_PANEL_ADDR"), os.Getenv("TDS_HTTP_ADDR"))
		}
		// exited fires if the server stops on its own (bad config, port in use).
		exited := make(chan error, 1)
		if server != nil {
			go func(s *exec.Cmd) { exited <- s.Wait() }(server)
		}
		changed := false
		for !changed {
			select {
			case <-stop:
				if server != nil {
					server.Process.Kill()
				}
				return
			case err := <-exited:
				fmt.Printf("dev: server exited (%v), waiting for a change\n", err)
				server = nil
			case <-time.After(500 * time.Millisecond):
				changed = newest().After(built)
			}
		}
		fmt.Println("dev: change detected, restarting")
		if server != nil {
			server.Process.Kill()
			<-exited
		}
	}
}
