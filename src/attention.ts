import type { DatabaseSync } from 'node:sqlite';
import type { AttentionReason, Threads } from './api';
import type { GitHub } from './github';

interface Observation { head: string; requests: string[]; replies: string[] }
interface RequestEvent {
  id: number; event: string; requested_reviewer?: { login: string }; requested_team?: { id: number };
}
export interface RequestTargets {
  requested_reviewers: { login: string }[];
  requested_teams: { id: number }[];
}

export async function observeRequests(github: GitHub, issue: string, current: RequestTargets, login: string) {
  if (!Array.isArray(current.requested_reviewers) || !Array.isArray(current.requested_teams)) {
    throw new Error('Requested reviewer list unavailable');
  }
  const events: RequestEvent[] = [];
  for await (const event of github.pages<RequestEvent>(issue + '/events?per_page=100', data => data as RequestEvent[])) {
    if (['review_requested', 'review_request_removed'].includes(event.event)) {
      if (!Number.isSafeInteger(event.id) || !(event.requested_reviewer?.login || event.requested_team?.id)) {
        throw new Error('Review request event unavailable');
      }
      events.push(event);
    }
  }
  const targets: string[] = [];
  if (current.requested_reviewers.some(user => user.login.toLowerCase() === login)) targets.push('user:' + login);
  if (current.requested_teams.length) {
    const teams = new Set(current.requested_teams.map(team => team.id));
    for await (const team of github.pages<{ id: number }>('/user/teams?per_page=100', data => data as { id: number }[])) {
      if (teams.has(team.id)) targets.push('team:' + team.id);
    }
  }
  const reasons: AttentionReason[] = [];
  for (const target of targets) {
    const history = events.filter(e => (e.requested_team ? 'team:' + e.requested_team.id :
      'user:' + e.requested_reviewer?.login.toLowerCase()) === target);
    const latest = history.at(-1);
    if (latest?.event === 'review_request_removed') throw new Error('Review request state changed during Pull');
    const key = target + ':' + (latest?.id ?? 'outstanding');
    reasons.push({ key, kind: target.startsWith('team:') ? 'team_request' : 'direct_request' });
    if (history.filter(e => e.event === 'review_requested').length > 1) {
      reasons.push({ key: 'again:' + key, kind: 'explicit_rerequest' });
    }
  }
  return reasons;
}

export function reconcile(db: DatabaseSync, id: string, head: string, requests: AttentionReason[],
  threads: Threads['threads'], reviews: Threads['reviews'], login: string, author: string | null) {
  const row = db.prepare('SELECT observation FROM attention_state WHERE pr_id = ?').get(id);
  const old: Observation | undefined = row && JSON.parse(String(row.observation));
  const replies = threads.flatMap(thread => {
    const roots = new Set(thread.comments.filter(c => !c.replyTo && c.author?.toLowerCase() === login).map(c => c.id));
    return thread.comments.filter(c => c.replyTo && roots.has(c.replyTo.id) && author &&
      c.author?.toLowerCase() === author.toLowerCase()).map(c => c.id);
  });
  const observation: Observation = { head, requests: requests.map(r => r.key), replies };
  const changed = old && (head !== old.head || replies.some(key => !old.replies.includes(key)) ||
    observation.requests.some(key => !old.requests.includes(key)));
  db.prepare(`INSERT INTO attention_state(pr_id, observation) VALUES (?, ?)
    ON CONFLICT(pr_id) DO UPDATE SET observation=excluded.observation,
    snoozed=CASE WHEN ? THEN 0 ELSE snoozed END`).run(id, JSON.stringify(observation), Number(!!changed));
  db.prepare("UPDATE attention_events SET active=0 WHERE pr_id=? AND kind IN ('direct_request','team_request','explicit_rerequest')").run(id);
  const add = db.prepare(`INSERT INTO attention_events(pr_id, event_key, kind) VALUES (?, ?, ?)
    ON CONFLICT(pr_id,event_key) DO UPDATE SET active=1`);
  for (const reason of requests) add.run(id, reason.key, reason.kind);
  if (!old) return;
  for (const reply of replies) if (!old.replies.includes(reply)) add.run(id, 'reply:' + reply, 'author_reply');
  const decision = reviews.filter(r => r.author?.toLowerCase() === login &&
    ['CHANGES_REQUESTED','APPROVED','DISMISSED'].includes(r.state)).at(-1);
  if (head !== old.head && decision?.state === 'CHANGES_REQUESTED' && decision.commitSha && decision.commitSha !== head) {
    add.run(id, 'head:' + decision.id + ':' + head, 'commits_after_changes_requested');
  }
}
