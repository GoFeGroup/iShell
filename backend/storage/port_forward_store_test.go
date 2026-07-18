package storage

import "testing"

func TestSavePortForwardAssignsDefaults(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	saved, err := st.SavePortForward(PortForward{
		SessionID:  "sess-1",
		Type:       ForwardLocal,
		TargetHost: "internal.example.com",
		TargetPort: 5432,
	})
	if err != nil {
		t.Fatalf("SavePortForward: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected a generated ID")
	}
	if saved.CreatedAt == "" || saved.UpdatedAt == "" {
		t.Fatalf("expected timestamps, got created=%q updated=%q", saved.CreatedAt, saved.UpdatedAt)
	}
	if saved.BindAddr != "127.0.0.1" {
		t.Errorf("BindAddr default = %q, want 127.0.0.1", saved.BindAddr)
	}

	got, err := st.GetPortForward(saved.ID)
	if err != nil || got == nil {
		t.Fatalf("GetPortForward: %v", err)
	}
	if got.TargetHost != "internal.example.com" || got.TargetPort != 5432 {
		t.Fatalf("GetPortForward returned %+v", got)
	}
}

func TestSavePortForwardUpdatesExistingRule(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	first, err := st.SavePortForward(PortForward{SessionID: "sess-1", Type: ForwardLocal, TargetHost: "a", TargetPort: 1})
	if err != nil {
		t.Fatalf("initial SavePortForward: %v", err)
	}

	updated := *first
	updated.TargetHost = "b"
	updated.Enabled = true
	second, err := st.SavePortForward(updated)
	if err != nil {
		t.Fatalf("update SavePortForward: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("update changed ID: %q -> %q", first.ID, second.ID)
	}

	got, err := st.GetPortForward(first.ID)
	if err != nil || got == nil {
		t.Fatalf("GetPortForward: %v", err)
	}
	if got.TargetHost != "b" || !got.Enabled {
		t.Fatalf("update did not apply, got %+v", got)
	}
	if got.CreatedAt != first.CreatedAt {
		t.Fatalf("CreatedAt changed on update: %q -> %q", first.CreatedAt, got.CreatedAt)
	}
}

func TestGetPortForwardNotFoundReturnsNilWithoutError(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	got, err := st.GetPortForward("does-not-exist")
	if err != nil {
		t.Fatalf("GetPortForward: unexpected error %v", err)
	}
	if got != nil {
		t.Fatalf("GetPortForward = %+v, want nil", got)
	}
}

func TestListPortForwardsForSessionFiltersAndOrders(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	for _, target := range []string{"first", "second", "third"} {
		if _, err := st.SavePortForward(PortForward{SessionID: "sess-a", Type: ForwardLocal, TargetHost: target, TargetPort: 1}); err != nil {
			t.Fatalf("save %s: %v", target, err)
		}
	}
	if _, err := st.SavePortForward(PortForward{SessionID: "sess-b", Type: ForwardLocal, TargetHost: "other", TargetPort: 1}); err != nil {
		t.Fatalf("save other-session rule: %v", err)
	}

	got, err := st.ListPortForwardsForSession("sess-a")
	if err != nil {
		t.Fatalf("ListPortForwardsForSession: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 rules for sess-a, got %d", len(got))
	}
	for _, pf := range got {
		if pf.SessionID != "sess-a" {
			t.Fatalf("leaked rule from another session: %+v", pf)
		}
	}

	none, err := st.ListPortForwardsForSession("sess-nonexistent")
	if err != nil {
		t.Fatalf("ListPortForwardsForSession (unknown session): %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("expected no rules for unknown session, got %d", len(none))
	}
}

func TestDeletePortForwardRemovesItAndIsIdempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	saved, err := st.SavePortForward(PortForward{SessionID: "sess-1", Type: ForwardDynamic})
	if err != nil {
		t.Fatalf("SavePortForward: %v", err)
	}

	if err := st.DeletePortForward(saved.ID); err != nil {
		t.Fatalf("DeletePortForward: %v", err)
	}
	got, err := st.GetPortForward(saved.ID)
	if err != nil {
		t.Fatalf("GetPortForward after delete: %v", err)
	}
	if got != nil {
		t.Fatalf("rule still present after delete: %+v", got)
	}

	if err := st.DeletePortForward(saved.ID); err != nil {
		t.Fatalf("DeletePortForward (already gone): %v", err)
	}
	if err := st.DeletePortForward("never-existed"); err != nil {
		t.Fatalf("DeletePortForward (unknown id): %v", err)
	}
}
