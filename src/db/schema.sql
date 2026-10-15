-- Core schema. Statements are idempotent so the file can run on every start.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT,
  google_id   TEXT UNIQUE,
  role        TEXT NOT NULL DEFAULT 'volunteer'
              CHECK (role IN ('admin','finance','staff','volunteer')),
  active      INTEGER NOT NULL DEFAULT 1,
  last_login  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- A household. Address/phone live here; individuals live in people.
CREATE TABLE IF NOT EXISTS families (
  id            INTEGER PRIMARY KEY,
  family_name   TEXT NOT NULL,
  salutation    TEXT,            -- e.g. "Mr. & Mrs. Cohen"
  hebrew_name   TEXT,
  email         TEXT,
  phone         TEXT,
  mobile        TEXT,
  cep           TEXT,
  street        TEXT,
  number        TEXT,
  complement    TEXT,
  neighborhood  TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT DEFAULT 'Brasil',
  affiliation   TEXT,            -- e.g. member, friend, alumni, tourist
  priority      INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  source        TEXT,            -- how they came to us
  tax_id        TEXT,            -- CPF / CNPJ for receipts
  no_mail       INTEGER NOT NULL DEFAULT 0,
  no_email      INTEGER NOT NULL DEFAULT 0,
  no_sms        INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',  -- JSON object of admin-defined fields
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_families_name ON families(family_name);

CREATE TABLE IF NOT EXISTS people (
  id                 INTEGER PRIMARY KEY,
  family_id          INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL DEFAULT 'primary'
                     CHECK (relation IN ('primary','spouse','child','parent','other')),
  first_name         TEXT NOT NULL,
  last_name          TEXT,
  hebrew_name        TEXT,
  father_hebrew_name TEXT,
  mother_hebrew_name TEXT,
  gender             TEXT CHECK (gender IN ('M','F') OR gender IS NULL),
  lineage            TEXT CHECK (lineage IN ('kohen','levi','yisrael') OR lineage IS NULL),
  birth_date         TEXT,      -- YYYY-MM-DD
  birth_after_sunset INTEGER NOT NULL DEFAULT 0,
  email              TEXT,
  mobile             TEXT,
  deceased           INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_family ON people(family_id);

-- Multi-level categories (parent_id builds a tree).
CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE (name, parent_id)
);

CREATE TABLE IF NOT EXISTS family_categories (
  family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (family_id, category_id)
);

-- Lifecycle occasions: yahrzeits, birthdays, anniversaries, etc.
CREATE TABLE IF NOT EXISTS occasions (
  id                 INTEGER PRIMARY KEY,
  family_id          INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id          INTEGER REFERENCES people(id) ON DELETE SET NULL,
  type               TEXT NOT NULL
                     CHECK (type IN ('yahrzeit','birthday','anniversary','bar_mitzvah','bat_mitzvah','other')),
  name               TEXT NOT NULL,     -- name of deceased / celebrant
  hebrew_name        TEXT,
  relationship       TEXT,              -- e.g. "father of Moshe"
  gregorian_date     TEXT NOT NULL,     -- YYYY-MM-DD of original event
  after_sunset       INTEGER NOT NULL DEFAULT 0,
  observe            TEXT NOT NULL DEFAULT 'hebrew' CHECK (observe IN ('hebrew','gregorian')),
  remind             INTEGER NOT NULL DEFAULT 1,
  remind_days_before INTEGER NOT NULL DEFAULT 7,
  remind_email       INTEGER NOT NULL DEFAULT 1,
  remind_sms         INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_occasions_family ON occasions(family_id);

CREATE TABLE IF NOT EXISTS reminder_log (
  id           INTEGER PRIMARY KEY,
  occasion_id  INTEGER NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
  occurrence   TEXT NOT NULL,     -- YYYY-MM-DD of the observance reminded about
  channel      TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (occasion_id, occurrence, channel)
);

-- Funds / income categories (General, Building Fund, Holiday Appeals...).
CREATE TABLE IF NOT EXISTS funds (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  tax_deductible INTEGER NOT NULL DEFAULT 1,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pledges (
  id         INTEGER PRIMARY KEY,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  fund_id    INTEGER NOT NULL REFERENCES funds(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),   -- cents
  date       TEXT NOT NULL,
  due_date   TEXT,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every incoming payment. kind tells what it pays for.
CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY,
  family_id         INTEGER REFERENCES families(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('donation','order','registration')),
  ref_id            INTEGER,          -- order / registration id
  pledge_id         INTEGER REFERENCES pledges(id) ON DELETE SET NULL,
  date              TEXT NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),   -- cents
  method            TEXT NOT NULL DEFAULT 'cash'
                    CHECK (method IN ('cash','check','pix','card','transfer','online','other')),
  reference         TEXT,             -- check number, PIX id, etc.
  receipt_number    INTEGER UNIQUE,
  thanked_at        TEXT,
  stripe_session_id TEXT UNIQUE,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_family ON payments(family_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);

-- Split of a donation across funds. Sum of splits = payment amount.
CREATE TABLE IF NOT EXISTS payment_splits (
  id         INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  fund_id    INTEGER NOT NULL REFERENCES funds(id),
  amount     INTEGER NOT NULL CHECK (amount > 0)
);

-- Seasonal / Judaica items: Shmura Matzah, Arba Minim, Tefillin...
CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
           CHECK (category IN ('matzah','arba_minim','tefillin','mezuzah','candles','other')),
  season   TEXT,                -- e.g. "Pesach 5787"
  price    INTEGER NOT NULL DEFAULT 0,  -- cents
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ready','delivered','cancelled')),
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'other'
                 CHECK (type IN ('dinner','class','lecture','shabbaton','holiday','other')),
  starts_at      TEXT NOT NULL,     -- YYYY-MM-DDTHH:MM
  location       TEXT,
  description    TEXT,
  price_adult    INTEGER NOT NULL DEFAULT 0,
  price_student  INTEGER NOT NULL DEFAULT 0,
  price_child    INTEGER NOT NULL DEFAULT 0,
  capacity       INTEGER,
  open           INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS registrations (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  family_id  INTEGER REFERENCES families(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  adults     INTEGER NOT NULL DEFAULT 0,
  students   INTEGER NOT NULL DEFAULT 0,
  children   INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','free','cancelled')),
  checked_in INTEGER NOT NULL DEFAULT 0,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL CHECK (channel IN ('email','sms','call')),
  subject    TEXT,
  body       TEXT NOT NULL,
  criteria   TEXT NOT NULL DEFAULT '{}',
  sent_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_log (
  id          INTEGER PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  family_id   INTEGER REFERENCES families(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
