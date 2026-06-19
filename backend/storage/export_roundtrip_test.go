package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExportImportRoundTripSpecialChars(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "ishell-export-test")
	os.RemoveAll(dir)
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	defer os.RemoveAll(dir)

	tricky := []string{
		`p@ss: w0rd#123`,
		`'single quotes'`,
		`"double quotes"`,
		"line1\nline2\ttab",
		`back\slash\path`,
		`  leading and trailing  `,
		`yes`, // YAML 1.1 boolean-looking scalar
		`*anchor&ref!tag`,
		`你好密码🔒`,
		``,
	}

	var ids []string
	for i, pw := range tricky {
		sess, err := st.SaveSession(Session{
			Label:      "test",
			Host:       "example.com",
			Username:   "root",
			AuthType:   AuthPassword,
			Password:   pw,
			Passphrase: pw + "-pp",
		})
		if err != nil {
			t.Fatalf("save session %d: %v", i, err)
		}
		ids = append(ids, sess.ID)
	}

	data, err := st.ExportAll()
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	t.Logf("YAML output:\n%s", string(data))

	dir2 := filepath.Join(os.TempDir(), "ishell-export-test-2")
	os.RemoveAll(dir2)
	st2, err := Open(dir2)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	defer os.RemoveAll(dir2)

	result, err := st2.ImportAll(data)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if result.SessionCount != len(tricky) {
		t.Fatalf("expected %d sessions imported, got %d", len(tricky), result.SessionCount)
	}

	for i, id := range ids {
		got, err := st2.GetSession(id)
		if err != nil || got == nil {
			t.Fatalf("get session %d: %v", i, err)
		}
		want := tricky[i]
		if got.Password != want {
			t.Errorf("session %d password mismatch:\n want: %q\n got:  %q", i, want, got.Password)
		}
		if got.Passphrase != want+"-pp" {
			t.Errorf("session %d passphrase mismatch:\n want: %q\n got:  %q", i, want+"-pp", got.Passphrase)
		}
	}
}
