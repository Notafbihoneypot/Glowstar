package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testPub = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const otherPub = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func testAuthorizer(t *testing.T, entitlements []entitlement) *authorizer {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(entitlementResponse{PubKey: testPub, Entitlements: entitlements})
	}))
	t.Cleanup(srv.Close)
	return newAuthorizer(config{
		AdminURL:           srv.URL,
		AdminToken:         "secret",
		Feature:            "relay_30d",
		CacheTTL:           time.Second,
		HTTPTimeout:        time.Second,
		AllowLocalImports:  true,
		RequireAuthorMatch: true,
	})
}

func baseReq() policyRequest {
	return policyRequest{Type: "new", SourceType: "IP4", Authed: testPub, Event: nostrEvent{ID: strings.Repeat("c", 64), PubKey: testPub, Kind: 1}}
}

func TestPaidAuthenticatedAuthorAccepted(t *testing.T) {
	a := testAuthorizer(t, []entitlement{{Feature: "relay_30d", ValidUntil: time.Now().Add(time.Hour).Unix()}})
	if got := a.decide(baseReq()); got.Action != "accept" {
		t.Fatalf("got %#v", got)
	}
}

func TestNoAuthRequestsNIP42(t *testing.T) {
	a := testAuthorizer(t, nil)
	req := baseReq()
	req.Authed = ""
	got := a.decide(req)
	if got.Action != "reject" || !strings.HasPrefix(got.Msg, "auth-required:") {
		t.Fatalf("got %#v", got)
	}
}

func TestAuthorMismatchRejected(t *testing.T) {
	a := testAuthorizer(t, []entitlement{{Feature: "relay_30d", ValidUntil: time.Now().Add(time.Hour).Unix()}})
	req := baseReq()
	req.Event.PubKey = otherPub
	got := a.decide(req)
	if got.Action != "reject" || !strings.HasPrefix(got.Msg, "restricted:") {
		t.Fatalf("got %#v", got)
	}
}

func TestUnpaidRejected(t *testing.T) {
	a := testAuthorizer(t, nil)
	got := a.decide(baseReq())
	if got.Action != "reject" || !strings.Contains(got.Msg, "XMR relay access required") {
		t.Fatalf("got %#v", got)
	}
}

func TestLocalImportAllowed(t *testing.T) {
	a := testAuthorizer(t, nil)
	req := baseReq()
	req.SourceType = "Import"
	req.Authed = ""
	if got := a.decide(req); got.Action != "accept" {
		t.Fatalf("got %#v", got)
	}
}

func TestExpiredEntitlementRejected(t *testing.T) {
	a := testAuthorizer(t, []entitlement{{Feature: "relay_30d", ValidUntil: time.Now().Add(-time.Hour).Unix()}})
	if got := a.decide(baseReq()); got.Action != "reject" {
		t.Fatalf("got %#v", got)
	}
}
