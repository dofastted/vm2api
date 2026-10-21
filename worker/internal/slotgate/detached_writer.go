package slotgate

import (
	"net"
	"time"
)

// A submitted job belongs to the node until its original kernel response ends.
// Stop delivering after a dead/stalled controller, while Response.Write keeps
// consuming the same body through the terminal observer. Returning the delivery
// error would make net/http close that body before the node can observe its end.
type detachedResponseWriter struct {
	connection   net.Conn
	writeTimeout time.Duration
	detached     bool
}

func (w *detachedResponseWriter) Write(data []byte) (int, error) {
	if !w.detached {
		err := w.connection.SetWriteDeadline(time.Now().Add(w.writeTimeout))
		if err == nil {
			var written int
			written, err = w.connection.Write(data)
			if err == nil && written == len(data) {
				return written, nil
			}
		}
		w.detached = true
		w.connection.Close()
	}
	return len(data), nil
}
