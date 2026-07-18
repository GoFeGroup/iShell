package storage

import "testing"

func TestSaveSessionAssignsDefaults(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	saved, err := st.SaveSession(Session{Host: "example.com", Username: "root"})
	if err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected a generated ID")
	}
	if saved.CreatedAt == "" || saved.UpdatedAt == "" {
		t.Fatalf("expected timestamps to be set, got created=%q updated=%q", saved.CreatedAt, saved.UpdatedAt)
	}
	if saved.Port != 22 {
		t.Errorf("Port default = %d, want 22", saved.Port)
	}
	if saved.Keepalive != 60 {
		t.Errorf("Keepalive default = %d, want 60", saved.Keepalive)
	}
	if saved.Timeout != 30 {
		t.Errorf("Timeout default = %d, want 30", saved.Timeout)
	}
	if saved.Encoding != "UTF-8" {
		t.Errorf("Encoding default = %q, want UTF-8", saved.Encoding)
	}

	got, err := st.GetSession(saved.ID)
	if err != nil || got == nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.Host != "example.com" || got.Username != "root" {
		t.Fatalf("GetSession returned %+v", got)
	}
}

func TestSaveSessionUpdatesExistingRowAndPreservesCreatedAt(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	first, err := st.SaveSession(Session{Host: "a.example.com", Username: "root"})
	if err != nil {
		t.Fatalf("initial SaveSession: %v", err)
	}

	updated := *first
	updated.Host = "b.example.com"
	updated.Label = "renamed"
	second, err := st.SaveSession(updated)
	if err != nil {
		t.Fatalf("update SaveSession: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("update changed the ID: %q -> %q", first.ID, second.ID)
	}

	got, err := st.GetSession(first.ID)
	if err != nil || got == nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.Host != "b.example.com" || got.Label != "renamed" {
		t.Fatalf("update did not apply, got %+v", got)
	}
	if got.CreatedAt != first.CreatedAt {
		t.Fatalf("CreatedAt changed on update: %q -> %q", first.CreatedAt, got.CreatedAt)
	}

	list, err := st.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected exactly one session after update, got %d", len(list))
	}
}

func TestGetSessionNotFoundReturnsNilWithoutError(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	got, err := st.GetSession("does-not-exist")
	if err != nil {
		t.Fatalf("GetSession: unexpected error %v", err)
	}
	if got != nil {
		t.Fatalf("GetSession = %+v, want nil", got)
	}
}

func TestDeleteSessionRemovesItAndIsIdempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	saved, err := st.SaveSession(Session{Host: "example.com", Username: "root"})
	if err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	if err := st.DeleteSession(saved.ID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	got, err := st.GetSession(saved.ID)
	if err != nil {
		t.Fatalf("GetSession after delete: %v", err)
	}
	if got != nil {
		t.Fatalf("session still present after delete: %+v", got)
	}

	// Deleting again (or an ID that never existed) must not error.
	if err := st.DeleteSession(saved.ID); err != nil {
		t.Fatalf("DeleteSession (already gone): %v", err)
	}
	if err := st.DeleteSession("never-existed"); err != nil {
		t.Fatalf("DeleteSession (unknown id): %v", err)
	}
}
