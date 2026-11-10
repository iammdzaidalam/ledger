create table swarms (
    id               text primary key,
    idempotency_key  text,
    goal             text not null,
    repo             text not null default '',
    base_ref         text not null default '',
    model            text not null default '',
    gate             boolean not null,
    max_attempts     integer not null,
    state            text not null default 'running' check (state in ('running', 'done', 'cancelled')),
    created_at       timestamptz not null default now(),
    finished_at      timestamptz
);

create unique index swarms_idempotency on swarms (idempotency_key);
create index swarms_listing on swarms (created_at desc, id desc);

create table tasks (
    id            text primary key,
    swarm_id      text not null references swarms (id) on delete cascade,
    idx           integer not null,
    title         text not null default '',
    prompt        text not null,
    state         text not null default 'queued' check (state in
        ('queued', 'running', 'passed', 'merging', 'merged', 'conflict', 'blocked', 'failed', 'cancelled')),
    attempts      integer not null default 0,
    feedback      text not null default '',
    branch        text not null default '',
    commit_sha    text not null default '',
    detail        text not null default '',
    merge_worker  text not null default '',
    merge_until   timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    unique (swarm_id, idx)
);

create index tasks_claim on tasks (created_at, idx) where state = 'queued';
create index tasks_by_swarm on tasks (swarm_id, state);

create table attempts (
    id             text primary key,
    task_id        text not null references tasks (id) on delete cascade,
    swarm_id       text not null references swarms (id) on delete cascade,
    number         integer not null,
    worker_id      text not null,
    lease_seconds  integer not null,
    state          text not null default 'running' check (state in ('running', 'done', 'expired', 'cancelled')),
    decision       text not null default '',
    reason         text not null default '',
    feedback       text not null default '',
    branch         text not null default '',
    commit_sha     text not null default '',
    exit_code      integer not null default 0,
    flagged_turns  integer not null default 0,
    turns          integer not null default 0,
    summary        text not null default '',
    error          text not null default '',
    started_at     timestamptz not null default now(),
    leased_until   timestamptz not null,
    finished_at    timestamptz,
    unique (task_id, number)
);

create index attempts_lease on attempts (leased_until) where state = 'running';
create index attempts_by_swarm on attempts (swarm_id);
