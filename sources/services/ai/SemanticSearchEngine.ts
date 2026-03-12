/**
 * V5-UX-002: Intelligent Search Engine
 *
 * Uses OpenAI text-embedding-3-small for semantic search
 * Supports pgvector for similarity search in PostgreSQL
 */

import Anthropic from '@anthropic-ai/sdk';

export interface SearchResult {
  roleKey: string;
  roleId: string;
  similarity: number;
  description: string;
  metadata?: {
    title?: string;
    category?: string;
    skills?: string[];
  };
}

export interface SearchOptions {
  maxResults?: number;
  minSimilarity?: number;
  includeMetadata?: boolean;
}

export class SemanticSearchEngine {
  private anthropic: Anthropic | null = null;
  private openaiApiKey: string | undefined;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
    this.openaiApiKey = process.env.OPENAI_API_KEY;
  }

  private getClient(): Anthropic {
    if (!this.anthropic) {
      throw new Error('ANTHROPIC_API_KEY is not set — SemanticSearchEngine unavailable');
    }
    return this.anthropic;
  }

  /**
   * Generate embedding for text using OpenAI text-embedding-3-small
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Extract searchable text from role data
   */
  extractSearchableText(roleData: any): string {
    const parts: string[] = [];

    // Add title
    if (roleData.title || roleData.name) {
      parts.push(roleData.title || roleData.name);
    }

    // Add description/summary
    if (roleData.summary || roleData.description) {
      parts.push(roleData.summary || roleData.description);
    }

    // Add skills
    if (roleData.assignedSkills && Array.isArray(roleData.assignedSkills)) {
      parts.push(roleData.assignedSkills.join(', '));
    }

    // Add category
    if (roleData.policy?.coordinationMode) {
      parts.push(roleData.policy.coordinationMode);
    }

    return parts.join(' | ');
  }

  /**
   * Semantic search for roles
   * In production, this will use pgvector for efficient similarity search
   * For now, we implement in-memory search for MVP
   */
  async searchRoles(
    query: string,
    roleEmbeddings: Array<{
      roleKey: string;
      description: string;
      embedding: number[];
      metadata?: any;
    }>,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      maxResults = 5,
      minSimilarity = 0.5,
      includeMetadata = true,
    } = options;

    // Generate embedding for search query
    const queryEmbedding = await this.generateEmbedding(query);

    // Calculate similarity for each role
    const results = roleEmbeddings.map(role => {
      const similarity = this.cosineSimilarity(queryEmbedding, role.embedding);

      // Extract role ID from roleKey (format: "roles.<roleId>")
      const roleId = role.roleKey.replace(/^roles\./, '');

      return {
        roleKey: role.roleKey,
        roleId,
        similarity,
        description: role.description,
        metadata: includeMetadata ? role.metadata : undefined,
      };
    });

    // Filter by minimum similarity
    const filtered = results.filter(r => r.similarity >= minSimilarity);

    // Sort by similarity (descending) and limit results
    return filtered
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults);
  }

  /**
   * Batch search for multiple queries
   */
  async batchSearch(
    queries: string[],
    roleEmbeddings: Array<{
      roleKey: string;
      description: string;
      embedding: number[];
      metadata?: any;
    }>,
    options: SearchOptions = {}
  ): Promise<Map<string, SearchResult[]>> {
    const results = new Map<string, SearchResult[]>();

    for (const query of queries) {
      const searchResults = await this.searchRoles(query, roleEmbeddings, options);
      results.set(query, searchResults);
    }

    return results;
  }

  /**
   * Suggest similar roles based on a given role
   */
  async findSimilarRoles(
    targetRoleId: string,
    allRoles: Array<{
      id: string;
      embedding: number[];
    }>,
    options: SearchOptions = {}
  ): Promise<Array<{ roleId: string; similarity: number }>> {
    const targetRole = allRoles.find(r => r.id === targetRoleId);
    if (!targetRole) {
      return [];
    }

    const similarities = allRoles
      .filter(r => r.id !== targetRoleId)
      .map(role => ({
        roleId: role.id,
        similarity: this.cosineSimilarity(targetRole.embedding, role.embedding),
      }))
      .filter(r => r.similarity >= (options.minSimilarity || 0.5))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.maxResults || 5);

    return similarities;
  }
}
