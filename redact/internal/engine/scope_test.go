package redact

import (
	"strings"
	"testing"
)

func key32() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 1)
	}
	return k
}

func TestMaskRestoresInsideScopeOnly(t *testing.T) {
	a, err := NewScope(key32(), "key-a", "sess")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewScope(key32(), "key-b", "sess")
	if err != nil {
		t.Fatal(err)
	}
	const secret = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg"
	masked, n, err := a.MaskText("token "+secret, Options{Secrets: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || strings.Contains(masked, secret) || !strings.Contains(masked, "{{R_API_KEY_") {
		t.Fatalf("masked=%q n=%d", masked, n)
	}
	if got := a.RestoreText("vendor said "+masked, false); !strings.Contains(got, secret) {
		t.Fatalf("same scope did not restore: %q", got)
	}
	if got := b.RestoreText("vendor said "+masked, false); strings.Contains(got, secret) || got != "vendor said "+masked {
		t.Fatalf("other principal restored or rewrote: %q", got)
	}
	again, _, err := a.MaskText("token "+secret, Options{Secrets: true})
	if err != nil {
		t.Fatal(err)
	}
	if again != masked {
		t.Fatalf("tag unstable:\n%s\n%s", masked, again)
	}
}

func TestJSONKeepsToolID(t *testing.T) {
	s, err := NewScope(key32(), "key-a", "")
	if err != nil {
		t.Fatal(err)
	}
	const phone = "13800138000"
	body := []byte(`{"messages":[{"role":"user","content":"call ` + phone + `"}],"tools":[{"name":"echo","description":"ring ` + phone + `","input_schema":{"type":"object"}}]}`)
	out, n, err := s.MaskBody(body, Options{Secrets: true, Personal: true})
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 || strings.Contains(string(out), phone) {
		t.Fatalf("phone survived: %s n=%d", out, n)
	}
	if !strings.Contains(string(out), `"name":"echo"`) {
		t.Fatalf("tool name changed: %s", out)
	}
	if !strings.Contains(s.RestoreText(string(out), false), phone) {
		t.Fatal("restore lost the phone")
	}
}

func TestSignedSecretRejects(t *testing.T) {
	s, err := NewScope(key32(), "key-a", "s")
	if err != nil {
		t.Fatal(err)
	}
	const secret = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg"
	body := []byte(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"key ` + secret + `","signature":"sig"}]}]}`)
	_, _, err = s.MaskBody(body, Options{Secrets: true})
	if err == nil || err.Error() != "signed_history" {
		t.Fatalf("err=%v", err)
	}
}
