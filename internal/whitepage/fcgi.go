package whitepage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Minimal FastCGI responder client, enough to run a script on php-fpm.

const (
	fcgiBegin  = 1
	fcgiEnd    = 3
	fcgiParams = 4
	fcgiStdin  = 5
	fcgiStdout = 6
	fcgiStderr = 7

	fcgiMaxChunk  = 65535
	fcgiMaxOutput = 32 << 20
)

func fcgiRecord(w *bufio.Writer, typ byte, content []byte) {
	pad := (8 - len(content)%8) % 8
	w.Write([]byte{1, typ, 0, 1, byte(len(content) >> 8), byte(len(content)), byte(pad), 0})
	w.Write(content)
	w.Write(make([]byte, pad))
}

func fcgiStream(w *bufio.Writer, typ byte, data []byte) {
	for len(data) > 0 {
		n := min(len(data), fcgiMaxChunk)
		fcgiRecord(w, typ, data[:n])
		data = data[n:]
	}
	fcgiRecord(w, typ, nil) // empty record terminates the stream
}

func fcgiLen(b *bytes.Buffer, n int) {
	if n < 128 {
		b.WriteByte(byte(n))
		return
	}
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(n)|1<<31)
	b.Write(l[:])
}

// fcgiDo runs one request and returns the script's status, headers and body.
func fcgiDo(ctx context.Context, addr string, params map[string]string, stdin []byte) (int, http.Header, []byte, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("php runtime unreachable: %w", err)
	}
	defer conn.Close()
	deadline := time.Now().Add(30 * time.Second)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	conn.SetDeadline(deadline)

	w := bufio.NewWriter(conn)
	fcgiRecord(w, fcgiBegin, []byte{0, 1, 0, 0, 0, 0, 0, 0}) // role: responder, no keep-alive
	var pb bytes.Buffer
	for k, v := range params {
		fcgiLen(&pb, len(k))
		fcgiLen(&pb, len(v))
		pb.WriteString(k)
		pb.WriteString(v)
	}
	fcgiStream(w, fcgiParams, pb.Bytes())
	fcgiStream(w, fcgiStdin, stdin)
	if err := w.Flush(); err != nil {
		return 0, nil, nil, err
	}

	var stdout, stderr bytes.Buffer
	r := bufio.NewReader(conn)
	var head [8]byte
	for {
		if _, err := io.ReadFull(r, head[:]); err != nil {
			return 0, nil, nil, fmt.Errorf("php runtime: %w", err)
		}
		n := int(binary.BigEndian.Uint16(head[4:6]))
		pad := int(head[6])
		var dst io.Writer = io.Discard
		switch head[1] {
		case fcgiStdout:
			dst = &stdout
		case fcgiStderr:
			dst = &stderr
		}
		if _, err := io.CopyN(dst, r, int64(n)); err != nil {
			return 0, nil, nil, err
		}
		if _, err := r.Discard(pad); err != nil {
			return 0, nil, nil, err
		}
		if stdout.Len() > fcgiMaxOutput {
			return 0, nil, nil, errors.New("php output too large")
		}
		if head[1] == fcgiEnd {
			break
		}
	}
	if stdout.Len() == 0 {
		return 0, nil, nil, fmt.Errorf("php produced no output: %s", strings.TrimSpace(stderr.String()))
	}

	tp := textproto.NewReader(bufio.NewReader(&stdout))
	mh, err := tp.ReadMIMEHeader()
	if err != nil && len(mh) == 0 {
		return 0, nil, nil, fmt.Errorf("php sent malformed headers: %w", err)
	}
	header := http.Header(mh)
	status := http.StatusOK
	if s := header.Get("Status"); s != "" {
		code, _, _ := strings.Cut(s, " ")
		if n, err := strconv.Atoi(code); err == nil && n >= 100 && n < 600 {
			status = n
		}
		header.Del("Status")
	} else if header.Get("Location") != "" {
		status = http.StatusFound
	}
	body, _ := io.ReadAll(tp.R)
	return status, header, body, nil
}
