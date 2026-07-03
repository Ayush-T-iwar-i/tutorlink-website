const jwt = require('jsonwebtoken');

// ---------- Verify that a valid login token was sent ----------
// Used on any route that should only work for a logged-in user.
// Frontend must send: Authorization: Bearer <token>
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not logged in. Please log in and try again.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// ---------- Verify the logged-in user has a specific role ----------
// Usage: verifyToken, requireRole('teacher')
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can perform this action.` });
    }
    next();
  };
}

// ---------- Verify the logged-in user is acting on their own account ----------
// Usage: verifyToken, requireOwnUser  — for routes like /:userId/profile
function requireOwnUser(req, res, next) {
  const targetUserId = parseInt(req.params.userId, 10);
  if (req.user.id !== targetUserId) {
    return res.status(403).json({ error: 'You can only update your own account.' });
  }
  next();
}

module.exports = { verifyToken, requireRole, requireOwnUser };
