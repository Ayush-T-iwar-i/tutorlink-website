// they started. Only a short list of our own pages is accepted, so this can never be used as an open redirect.
const REDIRECT_ALLOWED = ['teacher-profile-view.html', 'teachers.html'];

function dashboardPathFor(role) {
  if (role === 'teacher') return 'teacher-dashboard.html';
  if (role === 'admin') return 'admin-dashboard.html';
  return 'student-dashboard.html';
}

// Returns the page to open after authentication: the requested one when it is allowed for this role,
// otherwise the role's dashboard.
function getPostAuthTarget(role) {
  const fallback = dashboardPathFor(role);
  try {
    const raw = new URLSearchParams(window.location.search).get('redirect');
    if (!raw || raw.length > 200) return fallback;
    const m = /^([a-z0-9-]+\.html)(\?[A-Za-z0-9=&._%-]*)?$/.exec(raw);
    if (!m || REDIRECT_ALLOWED.indexOf(m[1]) === -1) return fallback;
    // Only students can open a teacher profile to book.
    if (m[1] === 'teacher-profile-view.html' && role !== 'student') return fallback;
    return raw;
  } catch (e) {
    return fallback;
  }
}

// Keeps ?redirect=... on the "log in" / "sign up" switch links so it survives moving between the two pages.
function carryRedirectToLinks(selector) {
  try {
    const raw = new URLSearchParams(window.location.search).get('redirect');
    if (!raw) return;
    document.querySelectorAll(selector).forEach(function (a) {
      const sep = a.getAttribute('href').indexOf('?') === -1 ? '?' : '&';
      a.setAttribute('href', a.getAttribute('href') + sep + 'redirect=' + encodeURIComponent(raw));
    });
  } catch (e) { /* the links simply stay as they are */ }
}

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

    window.location.href = getPostAuthTarget(data.user.role);
  } catch (err) {
    onError(err.message || "Google sign-in didn't go through. Please try again.");
  }
}