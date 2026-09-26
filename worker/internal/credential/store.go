package credential

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	TypeOAuth      = "oauth"
	TypeSetupToken = "setup-token"
	TypeAPIKey     = "apikey"

	AuthSchemeXAPIKey = "x_api_key"
	AuthSchemeBearer  = "authorization_bearer"
)

type Credential struct {
	Type         string
	AccessToken  string
	RefreshToken string
	ExpiresAt    int64
	Generation   int64
	Email        string
	AccountUUID  string
	OrgUUID      string
	Scopes       []string
	APIKey       string
	BaseURL      string
	AuthScheme   string
}

func NormalizeType(raw string) string {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, "_", "-"))) {
	case TypeSetupToken, "inference":
		return TypeSetupToken
	case TypeAPIKey, "api-key", "console":
		return TypeAPIKey
	default:
		return TypeOAuth
	}
}

func (c Credential) IsAPIKey() bool {
	return NormalizeType(c.Type) == TypeAPIKey
}

func NormalizeAuthScheme(raw string, credType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, "-", "_"))) {
	case AuthSchemeBearer, "bearer", "authorization", "oauth":
		return AuthSchemeBearer
	case AuthSchemeXAPIKey, "apikey", "api_key":
		return AuthSchemeXAPIKey
	default:
		if NormalizeType(credType) == TypeAPIKey {
			return AuthSchemeXAPIKey
		}
		return AuthSchemeBearer
	}
}

func (c Credential) ResolvedAuthScheme() string {
	return NormalizeAuthScheme(c.AuthScheme, c.Type)
}

func (c Credential) Token() string {
	if c.IsAPIKey() {
		if key := strings.TrimSpace(c.APIKey); key != "" {
			return key
		}
	}
	return strings.TrimSpace(c.AccessToken)
}

func (c Credential) Valid() bool {
	return c.Token() != ""
}

func (c Credential) NeedsRefresh(now time.Time, skew time.Duration) bool {
	if c.IsAPIKey() {
		return false
	}
	if !c.Valid() {
		return true
	}
	// Official `claude setup-token` is a one-year oat with no refresh.
	if NormalizeType(c.Type) == TypeSetupToken && strings.TrimSpace(c.RefreshToken) == "" {
		if c.ExpiresAt <= 0 {
			return false
		}
		return time.UnixMilli(c.ExpiresAt).Sub(now) <= skew
	}
	if c.ExpiresAt <= 0 {
		return true
	}
	return time.UnixMilli(c.ExpiresAt).Sub(now) <= skew
}

type Store struct {
	Path     string
	LockPath string
}

func NewStore(path string) *Store {
	return &Store{Path: path, LockPath: path + ".lock"}
}

func (s *Store) Load() (Credential, map[string]any, error) {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return Credential{}, nil, fmt.Errorf("read credentials: %w", err)
	}
	var document map[string]any
	if err = json.Unmarshal(data, &document); err != nil {
		return Credential{}, nil, fmt.Errorf("decode credentials: %w", err)
	}
	oauth := nestedMap(document, "claudeAiOauth")
	if oauth == nil {
		oauth = document
	}
	if oauth == nil {
		return Credential{}, nil, errors.New("credentials oauth object is missing")
	}
	scopes := stringSlice(firstValue(oauth, "scopes", "scope"))
	credential := Credential{
		Type:         NormalizeType(firstString(document, "type")),
		AccessToken:  firstString(oauth, "accessToken", "access_token"),
		RefreshToken: firstString(oauth, "refreshToken", "refresh_token"),
		ExpiresAt:    normalizeExpiry(firstValue(oauth, "expiresAt", "expires_at")),
		Generation:   firstInt64(oauth, "kinGeneration", "kin_generation", "_token_version"),
		Email:        firstString(oauth, "email", "emailAddress", "email_address"),
		AccountUUID:  firstString(oauth, "accountUuid", "account_uuid"),
		OrgUUID:      firstString(oauth, "orgUuid", "org_uuid", "organization_uuid"),
		Scopes:       scopes,
		AuthScheme:   firstString(document, "authScheme", "auth_scheme"),
	}
	if typed := firstString(oauth, "type"); typed != "" && credential.Type == TypeOAuth {
		credential.Type = NormalizeType(typed)
	}
	if hasFullOAuthScope(scopes) {
		credential.Type = TypeOAuth
	}
	if api := nestedMap(document, "anthropicApiKey"); api != nil {
		if key := firstString(api, "apiKey", "api_key"); key != "" {
			credential.Type = TypeAPIKey
			credential.APIKey = key
			credential.AccessToken = key
			credential.BaseURL = firstString(api, "baseUrl", "base_url")
			if credential.Email == "" {
				credential.Email = firstString(api, "email")
			}
			if credential.AuthScheme == "" {
				credential.AuthScheme = firstString(api, "authScheme", "auth_scheme")
			}
		}
	}
	if credential.AuthScheme == "" {
		credential.AuthScheme = firstString(oauth, "authScheme", "auth_scheme")
	}
	if credential.Generation == 0 {
		credential.Generation = firstInt64(document, "kinGeneration", "kin_generation", "_token_version")
	}
	return credential, document, nil
}

func (s *Store) Status() (Credential, error) {
	credential, _, err := s.Load()
	return credential, err
}

func (s *Store) Save(credential Credential, document map[string]any) (Credential, error) {
	if !credential.Valid() {
		return Credential{}, errors.New("access token is required")
	}
	if document == nil {
		document = make(map[string]any)
	}
	credential.Type = NormalizeType(credential.Type)
	if hasFullOAuthScope(credential.Scopes) {
		credential.Type = TypeOAuth
	}
	credential.AuthScheme = NormalizeAuthScheme(credential.AuthScheme, credential.Type)
	document["type"] = credential.Type
	document["authScheme"] = credential.AuthScheme
	if credential.IsAPIKey() {
		api := nestedMap(document, "anthropicApiKey")
		if api == nil {
			api = make(map[string]any)
			document["anthropicApiKey"] = api
		}
		api["apiKey"] = credential.Token()
		if credential.BaseURL != "" {
			api["baseUrl"] = credential.BaseURL
		}
		delete(document, "claudeAiOauth")
		currentGeneration := firstInt64(document, "kinGeneration", "kin_generation", "_token_version")
		if credential.Generation <= currentGeneration {
			credential.Generation = currentGeneration + 1
		}
		if now := time.Now().UnixMilli(); credential.Generation < now {
			credential.Generation = now
		}
		document["kinGeneration"] = credential.Generation
		data, err := json.MarshalIndent(document, "", "  ")
		if err != nil {
			return Credential{}, fmt.Errorf("encode credentials: %w", err)
		}
		data = append(data, '\n')
		if err = atomicWrite(s.Path, data, 0o600); err != nil {
			return Credential{}, err
		}
		return credential, nil
	}
	oauth := nestedMap(document, "claudeAiOauth")
	if oauth == nil {
		oauth = make(map[string]any)
		document["claudeAiOauth"] = oauth
	}
	currentGeneration := firstInt64(oauth, "kinGeneration", "kin_generation", "_token_version")
	if credential.Generation <= currentGeneration {
		credential.Generation = currentGeneration + 1
	}
	if now := time.Now().UnixMilli(); credential.Generation < now {
		credential.Generation = now
	}
	oauth["accessToken"] = credential.AccessToken
	if credential.RefreshToken != "" {
		oauth["refreshToken"] = credential.RefreshToken
	} else if credential.Type == TypeSetupToken {
		delete(oauth, "refreshToken")
	}
	if credential.ExpiresAt > 0 {
		oauth["expiresAt"] = credential.ExpiresAt
	}
	oauth["kinGeneration"] = credential.Generation
	if credential.Email != "" {
		oauth["email"] = credential.Email
	}
	if credential.AccountUUID != "" {
		oauth["accountUuid"] = credential.AccountUUID
	}
	if credential.OrgUUID != "" {
		oauth["orgUuid"] = credential.OrgUUID
	}
	if len(credential.Scopes) > 0 {
		oauth["scopes"] = credential.Scopes
	}
	if credential.Type == TypeSetupToken {
		oauth["type"] = TypeSetupToken
	}
	document["kinGeneration"] = credential.Generation
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return Credential{}, fmt.Errorf("encode credentials: %w", err)
	}
	data = append(data, '\n')
	if err = atomicWrite(s.Path, data, 0o600); err != nil {
		return Credential{}, err
	}
	return credential, nil
}

func (s *Store) WithLock(ctx context.Context, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(s.LockPath), 0o700); err != nil {
		return fmt.Errorf("create credential lock directory: %w", err)
	}
	file, err := os.OpenFile(s.LockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open credential lock: %w", err)
	}
	defer file.Close()
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return fmt.Errorf("lock credentials: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return fn()
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create credential directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".credentials-*.tmp")
	if err != nil {
		return fmt.Errorf("create credential temp file: %w", err)
	}
	tempPath := temp.Name()
	cleanup := func() {
		temp.Close()
		_ = os.Remove(tempPath)
	}
	if err = temp.Chmod(mode); err != nil {
		cleanup()
		return fmt.Errorf("chmod credential temp file: %w", err)
	}
	if _, err = temp.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("write credential temp file: %w", err)
	}
	if err = temp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync credential temp file: %w", err)
	}
	if err = temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("close credential temp file: %w", err)
	}
	if err = os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("replace credential file: %w", err)
	}
	if err = os.Chmod(path, mode); err != nil {
		return fmt.Errorf("chmod credential file: %w", err)
	}
	if directory, openErr := os.Open(dir); openErr == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func nestedMap(document map[string]any, key string) map[string]any {
	if document == nil {
		return nil
	}
	value, ok := document[key]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		return typed
	default:
		return nil
	}
}

func firstValue(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			return value
		}
	}
	return nil
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			if text, okString := value.(string); okString {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func firstInt64(values map[string]any, keys ...string) int64 {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			if number := asInt64(value); number != 0 {
				return number
			}
		}
	}
	return 0
}

func normalizeExpiry(value any) int64 {
	expiry := asInt64(value)
	if expiry > 0 && expiry < 10_000_000_000 {
		expiry *= 1000
	}
	return expiry
}

func asInt64(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		number, _ := typed.Int64()
		return number
	case string:
		number, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return number
	default:
		return 0
	}
}
func hasFullOAuthScope(scopes []string) bool {
	for _, scope := range scopes {
		if scope == "user:profile" || scope == "user:office" || scope == "user:sessions:claude_code" {
			return true
		}
	}
	return false
}

func stringSlice(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
		return result
	case string:
		return strings.Fields(typed)
	default:
		return nil
	}
}

func DecodeImport(reader io.Reader, maxBytes int64) (Credential, error) {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	var payload struct {
		Type         string   `json:"type"`
		AccessToken  string   `json:"access_token"`
		RefreshToken string   `json:"refresh_token"`
		APIKey       string   `json:"api_key"`
		BaseURL      string   `json:"base_url"`
		AuthScheme   string   `json:"auth_scheme"`
		ExpiresAt    int64    `json:"expires_at"`
		ExpiresIn    int64    `json:"expires_in"`
		Email        string   `json:"email"`
		AccountUUID  string   `json:"account_uuid"`
		OrgUUID      string   `json:"org_uuid"`
		Scopes       []string `json:"scopes"`
	}
	decoder := json.NewDecoder(io.LimitReader(reader, maxBytes))
	if err := decoder.Decode(&payload); err != nil {
		return Credential{}, fmt.Errorf("decode credential import: %w", err)
	}
	expiry := payload.ExpiresAt
	if expiry > 0 && expiry < 10_000_000_000 {
		expiry *= 1000
	}
	if expiry == 0 && payload.ExpiresIn > 0 {
		expiry = time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second).UnixMilli()
	}
	typ := NormalizeType(payload.Type)
	if hasFullOAuthScope(payload.Scopes) {
		typ = TypeOAuth
	}
	apiKey := strings.TrimSpace(payload.APIKey)
	if apiKey == "" && typ == TypeAPIKey {
		apiKey = strings.TrimSpace(payload.AccessToken)
	}
	if apiKey != "" && (typ == TypeAPIKey || strings.HasPrefix(apiKey, "sk-ant-api03-")) {
		return Credential{
			Type:        TypeAPIKey,
			APIKey:      apiKey,
			AccessToken: apiKey,
			BaseURL:     strings.TrimSpace(payload.BaseURL),
			Email:       strings.TrimSpace(payload.Email),
			AccountUUID: strings.TrimSpace(payload.AccountUUID),
			OrgUUID:     strings.TrimSpace(payload.OrgUUID),
			AuthScheme:  NormalizeAuthScheme(payload.AuthScheme, TypeAPIKey),
		}, nil
	}
	return Credential{
		Type:         typ,
		AccessToken:  strings.TrimSpace(payload.AccessToken),
		RefreshToken: strings.TrimSpace(payload.RefreshToken),
		ExpiresAt:    expiry,
		Email:        strings.TrimSpace(payload.Email),
		AccountUUID:  strings.TrimSpace(payload.AccountUUID),
		OrgUUID:      strings.TrimSpace(payload.OrgUUID),
		Scopes:       payload.Scopes,
		AuthScheme:   NormalizeAuthScheme(payload.AuthScheme, typ),
	}, nil
}
