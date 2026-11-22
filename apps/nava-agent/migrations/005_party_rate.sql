-- Dated party rate memory: HMS rate plan per party stay, readable only when seen_at < as_of.
CREATE TABLE IF NOT EXISTS nava_agent.party_rate (
 property_code text NOT NULL, party_kind text NOT NULL CHECK (party_kind IN ('organization','agency')),
 party_name text NOT NULL, arrival_date date NOT NULL, rate_plan text NOT NULL, seen_at timestamptz NOT NULL,
 PRIMARY KEY (property_code, party_kind, party_name, arrival_date, seen_at));
