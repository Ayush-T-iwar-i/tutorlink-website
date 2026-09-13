// The Client ID lives in one place — the server's .env (GOOGLE_CLIENT_ID) —
// and is served here via /api/config. This used to be hardcoded in this
// file too, which meant changing it in .env silently did nothing on the
// frontend. Cached after the first fetch so we don't re-request it for
// every button render.
let _cachedGoogleClientId = null;

async function getGoogleClientId() {
  if (_cachedGoogleClientId !== null) return _cachedGoogleClientId;
  try {
    const config = await apiRequest('/api/config');
    _cachedGoogleClientId = config.googleClientId || '';
  } catch (err) {
    _cachedGoogleClientId = '';
  }
  return _cachedGoogleClientId;
}

/**
 * Renders the "Continue with Google" button into `container`.
 *
 * @param {HTMLElement} container   Element to render the button into.
 * @param {Function|null} getRole   Called at click-time to read the currently
 *                                  selected role ("student" | "teacher").
 *                                  Pass null on the login page, where the
 *                                  role isn't chosen — the backend will
 *                                  return whichever role the account has.
 * @param {Function} onError        Called with a friendly message on failure.
 */
async function initGoogleSignIn(container, getRole, onError) {
  const clientId = await getGoogleClientId();
  if (!clientId) {
    // Google Sign-In isn't configured on this server — hide the button
    // entirely rather than rendering something broken.
    container.style.display = 'none';
    return;
  }

  if (!window.google || !window.google.accounts) {
    // gsi client script hasn't loaded yet — retry shortly rather than
    // silently failing to render a button.
    setTimeout(() => initGoogleSignIn(container, getRole, onError), 200);
    return;
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => handleGoogleCredential(response, getRole, onError),
  });

  google.accounts.id.renderButton(container, {
    type: "standard",
    theme: "outline",
    size: "large",
    shape: "pill",
    text: getRole ? "signup_with" : "signin_with",
    logo_alignment: "left",
    width: container.offsetWidth || 360,
  });
}

async function handleGoogleCredential(response, getRole, onError) {
  try {
    const payload = { credential: response.credential };
    if (getRole) payload.role = getRole();

    const data = await apiRequest("/api/auth/google", "POST", payload);
    saveSession(data.user);

    window.location.href =
      data.user.role === "teacher" ? "teacher-dashboard.html" : "student-dashboard.html";
  } catch (err) {
    onError(err.message || "Google sign-in didn't go through. Please try again.");
  }
}