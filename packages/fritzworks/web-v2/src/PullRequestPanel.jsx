import { useEffect, useRef, useState } from 'react';

import { readPullRequest } from './api.js';
import { LinkIcon, Spinner } from './icons.jsx';
import { MarkdownPreview } from './MarkdownEditor.jsx';

function Attribution({ author, date }) {
  return <p className="mb-2 text-xs text-muted">
    {author?.login || 'Deleted user'}{date && <> · <time dateTime={date}>{new Date(date).toLocaleString()}</time></>}
  </p>;
}

export default function PullRequestPanel({
  panel, panelName, resource, target, focused, visible = true, onFocus,
  headerActions, headerProps, titleContent, onPanelNavigate,
}) {
  const [pr, setPr] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const contentRef = useRef(null);
  const resourceId = resource.id;
  const targetUrl = target?.url || '';

  useEffect(() => { setPr(null); }, [resourceId, targetUrl]);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void readPullRequest(resourceId, controller.signal, { url: targetUrl })
      .then((result) => { if (!controller.signal.aborted) setPr(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [resourceId, targetUrl, visible, reload]);

  useEffect(() => {
    if (focused && visible) contentRef.current?.focus();
  }, [focused, visible]);

  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden ring-inset ${focused ? 'ring-2 ring-accent/60' : ''}`}
      data-panel={panelName}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      onKeyDown={(event) => {
        if (event.ctrlKey && ['h', 'l'].includes(event.key)) {
          event.preventDefault();
          onPanelNavigate?.(event.key === 'h' ? -1 : 1);
        }
      }}
    >
      <header
        {...headerProps}
        className={`flex h-8 shrink-0 items-center gap-2 border-b border-primary/30 px-2 font-mono text-xs font-bold text-primary ${headerProps?.className || ''}`}
      >
        <LinkIcon className="size-3.5" />
        {titleContent || <span className="min-w-0 flex-1 truncate">{panel.label}</span>}
        <a className="rounded border border-primary px-2 py-0.5 hover:bg-soft hover:text-on-soft" href={resource.value} target="_blank" rel="noreferrer noopener">Open on GitHub</a>
        <button type="button" className="rounded border border-primary px-2 py-0.5 disabled:opacity-40" disabled={loading} onClick={() => setReload((value) => value + 1)}>Reload</button>
        {headerActions}
      </header>
      <div ref={contentRef} tabIndex={0} aria-label={`${panel.label} pull request`} className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm text-ink outline-none">
        {visible && <>
          {loading && <p role="status" className="flex items-center gap-2 text-muted"><Spinner /> Loading pull request…</p>}
          {error && <p role="alert" className="my-2 text-primary">{error}</p>}
          {pr && <>
            <h1 className="mb-2 text-xl font-bold">{pr.title} <span className="text-muted">#{pr.number}</span></h1>
            <p className="mb-2 text-xs font-bold">{pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state}</p>
            <Attribution author={pr.author} date={pr.createdAt} />
            <div className="markdown-preview"><MarkdownPreview>{pr.body || '_No description provided._'}</MarkdownPreview></div>
            <h2 className="my-4 border-t border-primary/30 pt-4 font-bold">Comments ({pr.comments.length})</h2>
            <p className="mb-3 text-xs text-muted">Conversation comments. Code review threads are available on GitHub.</p>
            {pr.comments.length === 0 && <p className="text-muted">No conversation comments yet.</p>}
            {pr.comments.map((comment, index) => <article key={comment.id || index} className="mb-4 rounded border border-primary/30 p-3">
              <Attribution author={comment.author} date={comment.createdAt} />
              <div className="markdown-preview"><MarkdownPreview>{comment.body || '_Empty comment._'}</MarkdownPreview></div>
            </article>)}
          </>}
        </>}
      </div>
    </section>
  );
}
