package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type nostrEvent struct {
	ID     string `json:"id"`
	PubKey string `json:"pubkey"`
	Kind   int    `json:"kind"`
}

type policyRequest struct {
	Type       string     `json:"type"`
	Event      nostrEvent `json:"event"`
	ReceivedAt int64      `json:"receivedAt"`
	SourceType string     `json:"sourceType"`
	SourceInfo string     `json:"sourceInfo"`
	Authed     string     `json:"authed,omitempty"`
}

type policyResponse struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Msg    string `json:"msg,omitempty"`
}

type entitlement struct {
	Feature    string `json:"feature"`
	Target     string `json:"target"`
	ValidUntil int64  `json:"valid_until"`
	InvoiceID  string `json:"invoice_id"`
}

type entitlementResponse struct {
	PubKey       string        `json:"pubkey"`
	Entitlements []entitlement `json:"entitlements"`
}

type config struct {
	AdminURL           string
	AdminToken         string
	Feature            string
	Target             string
	CacheTTL           time.Duration
	HTTPTimeout        time.Duration
	AllowLocalImports  bool
	RequireAuthorMatch bool
}

type cacheEntry struct {
	allowed bool
	expiry  time.Time
}

type authorizer struct {
	cfg    config
	client *http.Client
	mu     sync.Mutex
	cache  map[string]cacheEntry
}

func envBool(name string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func loadConfig() config {
	return config{
		AdminURL:           strings.TrimRight(strings.TrimSpace(valueOr(os.Getenv("GLOWSTR_COMMERCE_ADMIN_URL"), "http://commerce:8787/v1/admin")), "/"),
		AdminToken:         strings.TrimSpace(os.Getenv("GLOWSTR_COMMERCE_ADMIN_TOKEN")),
		Feature:            strings.TrimSpace(valueOr(os.Getenv("GLOWSTR_RELAY_FEATURE"), "relay_30d")),
		Target:             strings.TrimSpace(os.Getenv("GLOWSTR_RELAY_TARGET")),
		CacheTTL:           time.Duration(envInt("GLOWSTR_ENTITLEMENT_CACHE_SECONDS", 20)) * time.Second,
		HTTPTimeout:        time.Duration(envInt("GLOWSTR_COMMERCE_TIMEOUT_SECONDS", 3)) * time.Second,
		AllowLocalImports:  envBool("GLOWSTR_ALLOW_LOCAL_IMPORTS", true),
		RequireAuthorMatch: envBool("GLOWSTR_REQUIRE_AUTHOR_MATCH", true),
	}
}

func valueOr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func newAuthorizer(cfg config) *authorizer {
	return &authorizer{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.HTTPTimeout},
		cache:  make(map[string]cacheEntry),
	}
}

func validHexPubkey(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, c := range v {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func localMaintenanceSource(source string) bool {
	switch source {
	case "Import", "Stored":
		return true
	default:
		return false
	}
}

func (a *authorizer) decide(req policyRequest) policyResponse {
	res := policyResponse{ID: req.Event.ID}
	if req.Type != "new" || req.Event.ID == "" || !validHexPubkey(req.Event.PubKey) {
		res.Action = "reject"
		res.Msg = "invalid: malformed write-policy request"
		return res
	}

	if a.cfg.AllowLocalImports && localMaintenanceSource(req.SourceType) {
		res.Action = "accept"
		return res
	}

	authed := strings.ToLower(strings.TrimSpace(req.Authed))
	author := strings.ToLower(strings.TrimSpace(req.Event.PubKey))
	if authed == "" {
		res.Action = "reject"
		res.Msg = "auth-required: authenticate with NIP-42 before publishing"
		return res
	}
	if !validHexPubkey(authed) {
		res.Action = "reject"
		res.Msg = "restricted: invalid authenticated pubkey"
		return res
	}
	if a.cfg.RequireAuthorMatch && authed != author {
		res.Action = "reject"
		res.Msg = "restricted: authenticated pubkey must match event author"
		return res
	}

	allowed, err := a.hasRelayEntitlement(authed)
	if err != nil {
		res.Action = "reject"
		res.Msg = "error: XMR payment authorization unavailable"
		return res
	}
	if !allowed {
		res.Action = "reject"
		res.Msg = "restricted: XMR relay access required; purchase relay_30d in Glowstr"
		return res
	}

	res.Action = "accept"
	return res
}

func (a *authorizer) hasRelayEntitlement(pubkey string) (bool, error) {
	now := time.Now()
	a.mu.Lock()
	if hit, ok := a.cache[pubkey]; ok && now.Before(hit.expiry) {
		a.mu.Unlock()
		return hit.allowed, nil
	}
	a.mu.Unlock()

	if a.cfg.AdminToken == "" {
		return false, errors.New("GLOWSTR_COMMERCE_ADMIN_TOKEN is not configured")
	}

	req, err := http.NewRequest(http.MethodGet, a.cfg.AdminURL+"/entitlements/"+pubkey, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.AdminToken)
	req.Header.Set("Accept", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return false, fmt.Errorf("commerce returned HTTP %d", resp.StatusCode)
	}

	var body entitlementResponse
	dec := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := dec.Decode(&body); err != nil {
		return false, err
	}

	nowUnix := now.Unix()
	allowed := false
	for _, ent := range body.Entitlements {
		if ent.Feature != a.cfg.Feature || ent.ValidUntil <= nowUnix {
			continue
		}
		if a.cfg.Target != "" && ent.Target != "" && ent.Target != a.cfg.Target {
			continue
		}
		allowed = true
		break
	}

	a.mu.Lock()
	a.cache[pubkey] = cacheEntry{allowed: allowed, expiry: now.Add(a.cfg.CacheTTL)}
	a.mu.Unlock()
	return allowed, nil
}

func main() {
	authz := newAuthorizer(loadConfig())
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)

	for scanner.Scan() {
		var req policyRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			fmt.Fprintln(os.Stderr, "glowstr-xmr-policy: bad input:", err)
			continue
		}
		if err := enc.Encode(authz.decide(req)); err != nil {
			fmt.Fprintln(os.Stderr, "glowstr-xmr-policy: encode failed:", err)
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "glowstr-xmr-policy: stdin failed:", err)
		os.Exit(1)
	}
}
