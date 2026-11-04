CREATE TABLE wiki_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text NOT NULL,
  body text NOT NULL,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_pages_slug_check CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
  CONSTRAINT wiki_pages_title_check CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  CONSTRAINT wiki_pages_summary_check CHECK (char_length(summary) BETWEEN 1 AND 500 AND summary = btrim(summary)),
  CONSTRAINT wiki_pages_body_check CHECK (char_length(body) BETWEEN 1 AND 50000 AND body = btrim(body))
);

CREATE TABLE wiki_page_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  slug text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  body text NOT NULL,
  editor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  operation_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, revision),
  CONSTRAINT wiki_revisions_slug_check CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 80),
  CONSTRAINT wiki_revisions_title_check CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  CONSTRAINT wiki_revisions_summary_check CHECK (char_length(summary) BETWEEN 1 AND 500 AND summary = btrim(summary)),
  CONSTRAINT wiki_revisions_body_check CHECK (char_length(body) BETWEEN 1 AND 50000 AND body = btrim(body))
);

CREATE INDEX wiki_page_revisions_page_created_idx ON wiki_page_revisions (page_id, revision DESC);
CREATE INDEX wiki_pages_updated_idx ON wiki_pages (updated_at DESC, slug);

CREATE TABLE wiki_collaborators (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'editor')),
  granted_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wiki_collaborators_role_idx ON wiki_collaborators (role, granted_at, account_id);
