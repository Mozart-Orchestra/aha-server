--
-- PostgreSQL database dump
--

\restrict YO2nfs38EbqXthcCRtisI2OLp6bWS7PBmtW9MXR1HDLhcCs8qQ0CvJVNfqMCti6

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

--
-- Name: RelationshipStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."RelationshipStatus" AS ENUM (
    'none',
    'requested',
    'pending',
    'friend',
    'rejected'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: AccessKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AccessKey" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "machineId" text NOT NULL,
    "sessionId" text NOT NULL,
    data text NOT NULL,
    "dataVersion" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Account" (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    seq integer DEFAULT 0 NOT NULL,
    "feedSeq" bigint DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    settings text,
    "settingsVersion" integer DEFAULT 0 NOT NULL,
    "githubUserId" text,
    "supabaseUserId" text,
    email text,
    "firstName" text,
    "lastName" text,
    username text,
    avatar jsonb
);


--
-- Name: AccountAuthRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AccountAuthRequest" (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    response text,
    "responseAccountId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: AccountPushToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AccountPushToken" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Artifact" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    header bytea NOT NULL,
    "headerVersion" integer DEFAULT 0 NOT NULL,
    body bytea NOT NULL,
    "bodyVersion" integer DEFAULT 0 NOT NULL,
    "dataEncryptionKey" bytea NOT NULL,
    seq integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Genome; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Genome" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    name text NOT NULL,
    description text,
    spec text NOT NULL,
    "parentSessionId" text,
    "teamId" text,
    namespace text,
    version integer DEFAULT 1 NOT NULL,
    tags text,
    category text,
    status text DEFAULT 'unverified'::text NOT NULL,
    origin text,
    "variantOf" text,
    "mutationNote" text,
    scorecard text,
    "spawnCount" integer DEFAULT 0 NOT NULL,
    "lastSpawnedAt" timestamp(3) without time zone,
    "hubGenomeId" text,
    "isPublic" boolean DEFAULT false NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: GithubOrganization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GithubOrganization" (
    id text NOT NULL,
    profile jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: GithubUser; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GithubUser" (
    id text NOT NULL,
    profile jsonb NOT NULL,
    token bytea,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: GlobalLock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GlobalLock" (
    key text NOT NULL,
    value text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Machine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Machine" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    metadata text NOT NULL,
    "metadataVersion" integer DEFAULT 0 NOT NULL,
    "daemonState" text,
    "daemonStateVersion" integer DEFAULT 0 NOT NULL,
    "dataEncryptionKey" bytea,
    seq integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "lastActiveAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: MarketListing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MarketListing" (
    id text NOT NULL,
    ref text NOT NULL,
    digest text NOT NULL,
    "publisherId" text NOT NULL,
    genome jsonb NOT NULL,
    visibility jsonb NOT NULL,
    display jsonb NOT NULL,
    market jsonb NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    compatibility jsonb,
    pricing jsonb,
    "publishedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: MarketReview; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MarketReview" (
    id text NOT NULL,
    "listingId" text NOT NULL,
    "userId" text NOT NULL,
    rating integer NOT NULL,
    title text,
    review text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: RepeatKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RepeatKey" (
    key text NOT NULL,
    value text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ServiceAccountToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ServiceAccountToken" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    vendor text NOT NULL,
    token bytea NOT NULL,
    metadata jsonb,
    "lastUsedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Session" (
    id text NOT NULL,
    tag text NOT NULL,
    "accountId" text NOT NULL,
    metadata text NOT NULL,
    "metadataVersion" integer DEFAULT 0 NOT NULL,
    "agentState" text,
    "agentStateVersion" integer DEFAULT 0 NOT NULL,
    "dataEncryptionKey" bytea,
    seq integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "lastActiveAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SessionMessage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SessionMessage" (
    id text NOT NULL,
    "sessionId" text NOT NULL,
    "localId" text,
    seq integer NOT NULL,
    content jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SimpleCache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SimpleCache" (
    key text NOT NULL,
    value text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: TeamContextEntry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TeamContextEntry" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "teamId" text NOT NULL,
    key text NOT NULL,
    kind text DEFAULT 'fact'::text NOT NULL,
    value jsonb NOT NULL,
    summary text,
    tags jsonb,
    version integer DEFAULT 1 NOT NULL,
    "updatedBySessionId" text,
    "updatedByRole" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: TerminalAuthRequest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TerminalAuthRequest" (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "supportsV2" boolean DEFAULT false NOT NULL,
    response text,
    "responseAccountId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Trial; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Trial" (
    id text NOT NULL,
    "hubEntityId" text NOT NULL,
    "entityVersion" integer NOT NULL,
    "teamId" text,
    "sessionId" text,
    "contextNarrative" text,
    "logRefs" text,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "endedAt" timestamp(3) without time zone
);


--
-- Name: UploadedFile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UploadedFile" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    path text NOT NULL,
    width integer,
    height integer,
    thumbhash text,
    "reuseKey" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UsageReport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UsageReport" (
    id text NOT NULL,
    key text NOT NULL,
    "accountId" text NOT NULL,
    "sessionId" text,
    data jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserFeedItem; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserFeedItem" (
    id text NOT NULL,
    "userId" text NOT NULL,
    counter bigint NOT NULL,
    "repeatKey" text,
    body jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserKVStore; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserKVStore" (
    id text NOT NULL,
    "accountId" text NOT NULL,
    key text NOT NULL,
    value bytea,
    version integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: UserRelationship; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."UserRelationship" (
    "fromUserId" text NOT NULL,
    "toUserId" text NOT NULL,
    status public."RelationshipStatus" DEFAULT 'pending'::public."RelationshipStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "acceptedAt" timestamp(3) without time zone,
    "lastNotifiedAt" timestamp(3) without time zone
);


--
-- Name: Verdict; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Verdict" (
    id text NOT NULL,
    "trialId" text NOT NULL,
    "readerRole" text NOT NULL,
    "readerSessionId" text,
    content text NOT NULL,
    score integer,
    action text,
    dimensions text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: AccessKey AccessKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccessKey"
    ADD CONSTRAINT "AccessKey_pkey" PRIMARY KEY (id);


--
-- Name: AccountAuthRequest AccountAuthRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountAuthRequest"
    ADD CONSTRAINT "AccountAuthRequest_pkey" PRIMARY KEY (id);


--
-- Name: AccountPushToken AccountPushToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountPushToken"
    ADD CONSTRAINT "AccountPushToken_pkey" PRIMARY KEY (id);


--
-- Name: Account Account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);


--
-- Name: Artifact Artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_pkey" PRIMARY KEY (id);


--
-- Name: Genome Genome_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Genome"
    ADD CONSTRAINT "Genome_pkey" PRIMARY KEY (id);


--
-- Name: GithubOrganization GithubOrganization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GithubOrganization"
    ADD CONSTRAINT "GithubOrganization_pkey" PRIMARY KEY (id);


--
-- Name: GithubUser GithubUser_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GithubUser"
    ADD CONSTRAINT "GithubUser_pkey" PRIMARY KEY (id);


--
-- Name: GlobalLock GlobalLock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GlobalLock"
    ADD CONSTRAINT "GlobalLock_pkey" PRIMARY KEY (key);


--
-- Name: Machine Machine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine"
    ADD CONSTRAINT "Machine_pkey" PRIMARY KEY (id);


--
-- Name: MarketListing MarketListing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketListing"
    ADD CONSTRAINT "MarketListing_pkey" PRIMARY KEY (id);


--
-- Name: MarketReview MarketReview_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketReview"
    ADD CONSTRAINT "MarketReview_pkey" PRIMARY KEY (id);


--
-- Name: RepeatKey RepeatKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RepeatKey"
    ADD CONSTRAINT "RepeatKey_pkey" PRIMARY KEY (key);


--
-- Name: ServiceAccountToken ServiceAccountToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ServiceAccountToken"
    ADD CONSTRAINT "ServiceAccountToken_pkey" PRIMARY KEY (id);


--
-- Name: SessionMessage SessionMessage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionMessage"
    ADD CONSTRAINT "SessionMessage_pkey" PRIMARY KEY (id);


--
-- Name: Session Session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);


--
-- Name: SimpleCache SimpleCache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SimpleCache"
    ADD CONSTRAINT "SimpleCache_pkey" PRIMARY KEY (key);


--
-- Name: TeamContextEntry TeamContextEntry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TeamContextEntry"
    ADD CONSTRAINT "TeamContextEntry_pkey" PRIMARY KEY (id);


--
-- Name: TerminalAuthRequest TerminalAuthRequest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TerminalAuthRequest"
    ADD CONSTRAINT "TerminalAuthRequest_pkey" PRIMARY KEY (id);


--
-- Name: Trial Trial_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Trial"
    ADD CONSTRAINT "Trial_pkey" PRIMARY KEY (id);


--
-- Name: UploadedFile UploadedFile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadedFile"
    ADD CONSTRAINT "UploadedFile_pkey" PRIMARY KEY (id);


--
-- Name: UsageReport UsageReport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UsageReport"
    ADD CONSTRAINT "UsageReport_pkey" PRIMARY KEY (id);


--
-- Name: UserFeedItem UserFeedItem_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserFeedItem"
    ADD CONSTRAINT "UserFeedItem_pkey" PRIMARY KEY (id);


--
-- Name: UserKVStore UserKVStore_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserKVStore"
    ADD CONSTRAINT "UserKVStore_pkey" PRIMARY KEY (id);


--
-- Name: UserRelationship UserRelationship_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserRelationship"
    ADD CONSTRAINT "UserRelationship_pkey" PRIMARY KEY ("fromUserId", "toUserId");


--
-- Name: Verdict Verdict_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verdict"
    ADD CONSTRAINT "Verdict_pkey" PRIMARY KEY (id);


--
-- Name: AccessKey_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AccessKey_accountId_idx" ON public."AccessKey" USING btree ("accountId");


--
-- Name: AccessKey_accountId_machineId_sessionId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AccessKey_accountId_machineId_sessionId_key" ON public."AccessKey" USING btree ("accountId", "machineId", "sessionId");


--
-- Name: AccessKey_machineId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AccessKey_machineId_idx" ON public."AccessKey" USING btree ("machineId");


--
-- Name: AccessKey_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AccessKey_sessionId_idx" ON public."AccessKey" USING btree ("sessionId");


--
-- Name: AccountAuthRequest_publicKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AccountAuthRequest_publicKey_key" ON public."AccountAuthRequest" USING btree ("publicKey");


--
-- Name: AccountPushToken_accountId_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AccountPushToken_accountId_token_key" ON public."AccountPushToken" USING btree ("accountId", token);


--
-- Name: Account_githubUserId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Account_githubUserId_key" ON public."Account" USING btree ("githubUserId");


--
-- Name: Account_publicKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Account_publicKey_key" ON public."Account" USING btree ("publicKey");


--
-- Name: Account_supabaseUserId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Account_supabaseUserId_key" ON public."Account" USING btree ("supabaseUserId");


--
-- Name: Account_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Account_username_key" ON public."Account" USING btree (username);


--
-- Name: Artifact_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Artifact_accountId_idx" ON public."Artifact" USING btree ("accountId");


--
-- Name: Artifact_accountId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Artifact_accountId_updatedAt_idx" ON public."Artifact" USING btree ("accountId", "updatedAt" DESC);


--
-- Name: Genome_accountId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_accountId_updatedAt_idx" ON public."Genome" USING btree ("accountId", "updatedAt" DESC);


--
-- Name: Genome_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_category_idx" ON public."Genome" USING btree (category);


--
-- Name: Genome_deletedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_deletedAt_idx" ON public."Genome" USING btree ("deletedAt");


--
-- Name: Genome_namespace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_namespace_idx" ON public."Genome" USING btree (namespace);


--
-- Name: Genome_namespace_name_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Genome_namespace_name_version_key" ON public."Genome" USING btree (namespace, name, version);


--
-- Name: Genome_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_origin_idx" ON public."Genome" USING btree (origin);


--
-- Name: Genome_parentSessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_parentSessionId_idx" ON public."Genome" USING btree ("parentSessionId");


--
-- Name: Genome_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_status_idx" ON public."Genome" USING btree (status);


--
-- Name: Genome_teamId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_teamId_idx" ON public."Genome" USING btree ("teamId");


--
-- Name: Genome_variantOf_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Genome_variantOf_idx" ON public."Genome" USING btree ("variantOf");


--
-- Name: Machine_accountId_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Machine_accountId_id_key" ON public."Machine" USING btree ("accountId", id);


--
-- Name: Machine_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Machine_accountId_idx" ON public."Machine" USING btree ("accountId");


--
-- Name: MarketListing_digest_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MarketListing_digest_key" ON public."MarketListing" USING btree (digest);


--
-- Name: MarketListing_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MarketListing_ref_key" ON public."MarketListing" USING btree (ref);


--
-- Name: MarketReview_listingId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MarketReview_listingId_idx" ON public."MarketReview" USING btree ("listingId");


--
-- Name: MarketReview_listingId_userId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MarketReview_listingId_userId_key" ON public."MarketReview" USING btree ("listingId", "userId");


--
-- Name: ServiceAccountToken_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ServiceAccountToken_accountId_idx" ON public."ServiceAccountToken" USING btree ("accountId");


--
-- Name: ServiceAccountToken_accountId_vendor_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_key" ON public."ServiceAccountToken" USING btree ("accountId", vendor);


--
-- Name: SessionMessage_sessionId_localId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SessionMessage_sessionId_localId_key" ON public."SessionMessage" USING btree ("sessionId", "localId");


--
-- Name: SessionMessage_sessionId_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SessionMessage_sessionId_seq_idx" ON public."SessionMessage" USING btree ("sessionId", seq);


--
-- Name: Session_accountId_tag_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Session_accountId_tag_key" ON public."Session" USING btree ("accountId", tag);


--
-- Name: Session_accountId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_accountId_updatedAt_idx" ON public."Session" USING btree ("accountId", "updatedAt" DESC);


--
-- Name: TeamContextEntry_accountId_teamId_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "TeamContextEntry_accountId_teamId_key_key" ON public."TeamContextEntry" USING btree ("accountId", "teamId", key);


--
-- Name: TeamContextEntry_accountId_teamId_updatedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TeamContextEntry_accountId_teamId_updatedAt_idx" ON public."TeamContextEntry" USING btree ("accountId", "teamId", "updatedAt" DESC);


--
-- Name: TeamContextEntry_teamId_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "TeamContextEntry_teamId_kind_idx" ON public."TeamContextEntry" USING btree ("teamId", kind);


--
-- Name: TerminalAuthRequest_publicKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "TerminalAuthRequest_publicKey_key" ON public."TerminalAuthRequest" USING btree ("publicKey");


--
-- Name: Trial_hubEntityId_entityVersion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_hubEntityId_entityVersion_idx" ON public."Trial" USING btree ("hubEntityId", "entityVersion");


--
-- Name: Trial_hubEntityId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_hubEntityId_idx" ON public."Trial" USING btree ("hubEntityId");


--
-- Name: Trial_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_sessionId_idx" ON public."Trial" USING btree ("sessionId");


--
-- Name: Trial_teamId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Trial_teamId_idx" ON public."Trial" USING btree ("teamId");


--
-- Name: UploadedFile_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UploadedFile_accountId_idx" ON public."UploadedFile" USING btree ("accountId");


--
-- Name: UploadedFile_accountId_path_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UploadedFile_accountId_path_key" ON public."UploadedFile" USING btree ("accountId", path);


--
-- Name: UsageReport_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UsageReport_accountId_idx" ON public."UsageReport" USING btree ("accountId");


--
-- Name: UsageReport_accountId_sessionId_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UsageReport_accountId_sessionId_key_key" ON public."UsageReport" USING btree ("accountId", "sessionId", key);


--
-- Name: UsageReport_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UsageReport_sessionId_idx" ON public."UsageReport" USING btree ("sessionId");


--
-- Name: UserFeedItem_userId_counter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserFeedItem_userId_counter_idx" ON public."UserFeedItem" USING btree ("userId", counter DESC);


--
-- Name: UserFeedItem_userId_counter_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserFeedItem_userId_counter_key" ON public."UserFeedItem" USING btree ("userId", counter);


--
-- Name: UserFeedItem_userId_repeatKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserFeedItem_userId_repeatKey_key" ON public."UserFeedItem" USING btree ("userId", "repeatKey");


--
-- Name: UserKVStore_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserKVStore_accountId_idx" ON public."UserKVStore" USING btree ("accountId");


--
-- Name: UserKVStore_accountId_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UserKVStore_accountId_key_key" ON public."UserKVStore" USING btree ("accountId", key);


--
-- Name: UserRelationship_fromUserId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserRelationship_fromUserId_status_idx" ON public."UserRelationship" USING btree ("fromUserId", status);


--
-- Name: UserRelationship_toUserId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "UserRelationship_toUserId_status_idx" ON public."UserRelationship" USING btree ("toUserId", status);


--
-- Name: Verdict_readerRole_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Verdict_readerRole_idx" ON public."Verdict" USING btree ("readerRole");


--
-- Name: Verdict_trialId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Verdict_trialId_idx" ON public."Verdict" USING btree ("trialId");


--
-- Name: AccessKey AccessKey_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccessKey"
    ADD CONSTRAINT "AccessKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: AccessKey AccessKey_accountId_machineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccessKey"
    ADD CONSTRAINT "AccessKey_accountId_machineId_fkey" FOREIGN KEY ("accountId", "machineId") REFERENCES public."Machine"("accountId", id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: AccessKey AccessKey_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccessKey"
    ADD CONSTRAINT "AccessKey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."Session"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: AccountAuthRequest AccountAuthRequest_responseAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountAuthRequest"
    ADD CONSTRAINT "AccountAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: AccountPushToken AccountPushToken_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AccountPushToken"
    ADD CONSTRAINT "AccountPushToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Account Account_githubUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_githubUserId_fkey" FOREIGN KEY ("githubUserId") REFERENCES public."GithubUser"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: Artifact Artifact_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Artifact"
    ADD CONSTRAINT "Artifact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Genome Genome_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Genome"
    ADD CONSTRAINT "Genome_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Machine Machine_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine"
    ADD CONSTRAINT "Machine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: MarketReview MarketReview_listingId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MarketReview"
    ADD CONSTRAINT "MarketReview_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES public."MarketListing"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ServiceAccountToken ServiceAccountToken_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ServiceAccountToken"
    ADD CONSTRAINT "ServiceAccountToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SessionMessage SessionMessage_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SessionMessage"
    ADD CONSTRAINT "SessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."Session"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Session Session_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: TeamContextEntry TeamContextEntry_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TeamContextEntry"
    ADD CONSTRAINT "TeamContextEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: TerminalAuthRequest TerminalAuthRequest_responseAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TerminalAuthRequest"
    ADD CONSTRAINT "TerminalAuthRequest_responseAccountId_fkey" FOREIGN KEY ("responseAccountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UploadedFile UploadedFile_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UploadedFile"
    ADD CONSTRAINT "UploadedFile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: UsageReport UsageReport_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UsageReport"
    ADD CONSTRAINT "UsageReport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: UsageReport UsageReport_sessionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UsageReport"
    ADD CONSTRAINT "UsageReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public."Session"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: UserFeedItem UserFeedItem_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserFeedItem"
    ADD CONSTRAINT "UserFeedItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserKVStore UserKVStore_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserKVStore"
    ADD CONSTRAINT "UserKVStore_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserRelationship UserRelationship_fromUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserRelationship"
    ADD CONSTRAINT "UserRelationship_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: UserRelationship UserRelationship_toUserId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."UserRelationship"
    ADD CONSTRAINT "UserRelationship_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES public."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Verdict Verdict_trialId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Verdict"
    ADD CONSTRAINT "Verdict_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES public."Trial"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict YO2nfs38EbqXthcCRtisI2OLp6bWS7PBmtW9MXR1HDLhcCs8qQ0CvJVNfqMCti6

