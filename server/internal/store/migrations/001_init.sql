create table runs (
    id          text primary key,
    source      text not null default '',
    model       text not null default '',
    task        text not null default '',
    created_at  timestamptz not null default now()
);

create index runs_created on runs (created_at desc, id desc);

create table turns (
    run_id      text not null references runs (id) on delete cascade,
    turn        integer not null,
    text        text not null,
    text_hash   bytea not null,
    evidence    jsonb not null,
    fresh_refs  text[] not null default '{}',
    created_at  timestamptz not null default now(),
    primary key (run_id, turn)
);

create table verdicts (
    run_id      text not null,
    turn        integer not null,
    source      text not null,
    flagged     boolean not null,
    claims      jsonb not null,
    latency_us  bigint not null default 0,
    created_at  timestamptz not null default now(),
    primary key (run_id, turn, source),
    foreign key (run_id, turn) references turns (run_id, turn) on delete cascade
);

create table jobs (
    id            bigserial primary key,
    kind          text not null,
    payload       jsonb not null,
    state         text not null default 'queued' check (state in ('queued', 'running', 'done', 'dead')),
    attempts      integer not null default 0,
    max_attempts  integer not null default 5,
    run_after     timestamptz not null default now(),
    leased_until  timestamptz,
    last_error    text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index jobs_ready on jobs (kind, run_after) where state = 'queued';
create index jobs_leased on jobs (leased_until) where state = 'running';
