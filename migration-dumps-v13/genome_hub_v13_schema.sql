--
-- PostgreSQL database dump
--

\restrict 8W3eABMOkAPdc60oDHCJaxA64iGY2kenvtDHu3JW5bhyyQOortaAIAlrUg6EJDm

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Diff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Diff" (
    id text NOT NULL,
    entity_id text NOT NULL,
    version integer NOT NULL,
    description text NOT NULL,
    verdict_refs text,
    changes text NOT NULL,
    strategy text,
    author_role text,
    author_session text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: DiffLedger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DiffLedger" (
    id text NOT NULL,
    entity_id text NOT NULL,
    version integer NOT NULL,
    seq_no integer NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    diff_type text NOT NULL,
    path text,
    op text,
    old_value text,
    new_value text,
    content text
);


--
-- Name: Entity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Entity" (
    id text NOT NULL,
    kind text DEFAULT 'agent'::text NOT NULL,
    namespace text,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    description text,
    seed text,
    spec text NOT NULL,
    tags text,
    category text,
    "isPublic" boolean DEFAULT true NOT NULL,
    "spawnCount" integer DEFAULT 0 NOT NULL,
    download_count integer DEFAULT 0 NOT NULL,
    star_count integer DEFAULT 0 NOT NULL,
    "publisherId" text,
    "feedbackData" text,
    spec_diff text,
    "parentId" text,
    lifecycle text,
    search_text text,
    runtime_type text,
    execution_plane text,
    permission_mode text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: EntityFavorite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EntityFavorite" (
    id text NOT NULL,
    entity_id text NOT NULL,
    "actorId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: Trial; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Trial" (
    id text NOT NULL,
    entity_id text NOT NULL,
    entity_version integer NOT NULL,
    team_id text,
    context_narrative text,
    log_refs text NOT NULL,
    started_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ended_at timestamp(3) without time zone
);


--
-- Name: Verdict; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Verdict" (
    id text NOT NULL,
    trial_id text NOT NULL,
    reader_role text NOT NULL,
    reader_session_id text,
    content text NOT NULL,
    score integer,
    action text,
    dimensions text,
    context_narrative text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: DiffLedger DiffLedger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiffLedger"
    ADD CONSTRAINT "DiffLedger_pkey" PRIMARY KEY (id);


--
-- Name: Diff Diff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Diff"
    ADD CONSTRAINT "Diff_pkey" PRIMARY KEY (id);


--
-- Name: EntityFavorite EntityFavorite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EntityFavorite"
    ADD CONSTRAINT "EntityFavorite_pkey" PRIMARY KEY (id);


--
-- Name: Entity Entity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Entity"
    ADD CONSTRAINT "Entity_pkey" PRIMARY KEY (id);


--
-- Name: Trial Trial_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Trial"
    ADD CONSTRAINT "Trial_pkey" PRIMARY KEY (id);


--
-- Name: Verdict Verdict_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verdict"
    ADD CONSTRAINT "Verdict_pkey" PRIMARY KEY (id);


--
-- Name: DiffLedger_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DiffLedger_entity_id_idx" ON public."DiffLedger" USING btree (entity_id);


--
-- Name: DiffLedger_entity_id_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "DiffLedger_entity_id_version_idx" ON public."DiffLedger" USING btree (entity_id, version);


--
-- Name: DiffLedger_entity_id_version_seq_no_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "DiffLedger_entity_id_version_seq_no_key" ON public."DiffLedger" USING btree (entity_id, version, seq_no);


--
-- Name: Diff_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Diff_entity_id_idx" ON public."Diff" USING btree (entity_id);


--
-- Name: Diff_entity_id_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Diff_entity_id_version_idx" ON public."Diff" USING btree (entity_id, version);


--
-- Name: EntityFavorite_actorId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EntityFavorite_actorId_idx" ON public."EntityFavorite" USING btree ("actorId");


--
-- Name: EntityFavorite_entity_id_actorId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "EntityFavorite_entity_id_actorId_key" ON public."EntityFavorite" USING btree (entity_id, "actorId");


--
-- Name: EntityFavorite_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EntityFavorite_entity_id_idx" ON public."EntityFavorite" USING btree (entity_id);


--
-- Name: Entity_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_category_idx" ON public."Entity" USING btree (category);


--
-- Name: Entity_execution_plane_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_execution_plane_idx" ON public."Entity" USING btree (execution_plane);


--
-- Name: Entity_isPublic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_isPublic_idx" ON public."Entity" USING btree ("isPublic");


--
-- Name: Entity_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_kind_idx" ON public."Entity" USING btree (kind);


--
-- Name: Entity_lifecycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_lifecycle_idx" ON public."Entity" USING btree (lifecycle);


--
-- Name: Entity_namespace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_namespace_idx" ON public."Entity" USING btree (namespace);


--
-- Name: Entity_namespace_name_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Entity_namespace_name_version_key" ON public."Entity" USING btree (namespace, name, version);


--
-- Name: Entity_parentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_parentId_idx" ON public."Entity" USING btree ("parentId");


--
-- Name: Entity_runtime_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Entity_runtime_type_idx" ON public."Entity" USING btree (runtime_type);


--
-- Name: Trial_entity_id_entity_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_entity_id_entity_version_idx" ON public."Trial" USING btree (entity_id, entity_version);


--
-- Name: Trial_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_entity_id_idx" ON public."Trial" USING btree (entity_id);


--
-- Name: Trial_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_team_id_idx" ON public."Trial" USING btree (team_id);


--
-- Name: Verdict_reader_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Verdict_reader_role_idx" ON public."Verdict" USING btree (reader_role);


--
-- Name: Verdict_trial_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Verdict_trial_id_idx" ON public."Verdict" USING btree (trial_id);


--
-- Name: DiffLedger DiffLedger_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DiffLedger"
    ADD CONSTRAINT "DiffLedger_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public."Entity"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Diff Diff_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Diff"
    ADD CONSTRAINT "Diff_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public."Entity"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EntityFavorite EntityFavorite_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EntityFavorite"
    ADD CONSTRAINT "EntityFavorite_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public."Entity"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Trial Trial_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Trial"
    ADD CONSTRAINT "Trial_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public."Entity"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Verdict Verdict_trial_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verdict"
    ADD CONSTRAINT "Verdict_trial_id_fkey" FOREIGN KEY (trial_id) REFERENCES public."Trial"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 8W3eABMOkAPdc60oDHCJaxA64iGY2kenvtDHu3JW5bhyyQOortaAIAlrUg6EJDm

