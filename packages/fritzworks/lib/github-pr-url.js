// Shared by the daemon and browser so only supported PR links use this view.
export function githubPullRequestUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/);
    return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : null;
  } catch {
    return null;
  }
}
