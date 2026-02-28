import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SemanticSearchEngine } from './SemanticSearchEngine';

// Mock fetch for OpenAI API
global.fetch = vi.fn();
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

describe('SemanticSearchEngine', () => {
  let engine: SemanticSearchEngine;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    engine = new SemanticSearchEngine();
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_OPENAI_API_KEY === undefined) {
      delete process.env.OPENAI_API_KEY;
      return;
    }
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  });

  describe('cosineSimilarity', () => {
    it('should calculate cosine similarity correctly', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];

      const similarity = engine.cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];

      const similarity = engine.cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0, 5);
    });

    it('should handle partial similarity', () => {
      const a = [1, 1, 0];
      const b = [1, 0, 0];

      const similarity = engine.cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0.707, 2);
    });

    it('should throw error for different length vectors', () => {
      const a = [1, 0];
      const b = [1, 0, 0];

      expect(() => engine.cosineSimilarity(a, b)).toThrow('Vectors must have the same length');
    });

    it('should return 0 for zero vectors', () => {
      const a = [0, 0, 0];
      const b = [1, 1, 1];

      const similarity = engine.cosineSimilarity(a, b);
      expect(similarity).toBe(0);
    });
  });

  describe('extractSearchableText', () => {
    it('should extract text from role with all fields', () => {
      const roleData = {
        title: 'Frontend Developer',
        summary: 'React and TypeScript expert',
        assignedSkills: ['React', 'TypeScript', 'CSS'],
        policy: { coordinationMode: 'implementer' },
      };

      const text = engine.extractSearchableText(roleData);

      expect(text).toContain('Frontend Developer');
      expect(text).toContain('React and TypeScript expert');
      expect(text).toContain('React');
      expect(text).toContain('TypeScript');
      expect(text).toContain('implementer');
    });

    it('should handle role with minimal fields', () => {
      const roleData = {
        name: 'Backend Developer',
      };

      const text = engine.extractSearchableText(roleData);
      expect(text).toContain('Backend Developer');
    });

    it('should handle role with no skills', () => {
      const roleData = {
        title: 'QA Engineer',
        description: 'Testing specialist',
      };

      const text = engine.extractSearchableText(roleData);
      expect(text).toContain('QA Engineer');
      expect(text).toContain('Testing specialist');
    });
  });

  describe('generateEmbedding', () => {
    it('should generate embedding using OpenAI API', async () => {
      const mockEmbedding = new Array(1536).fill(0).map(() => Math.random());

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockEmbedding }],
        }),
      });

      const result = await engine.generateEmbedding('test query');

      expect(result).toEqual(mockEmbedding);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should throw error if OPENAI_API_KEY not configured', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const engineNoKey = new SemanticSearchEngine();

      await expect(engineNoKey.generateEmbedding('test')).rejects.toThrow(
        'OPENAI_API_KEY not configured'
      );

      process.env.OPENAI_API_KEY = originalKey;
    });

    it('should throw error on API failure', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        statusText: 'Unauthorized',
      });

      await expect(engine.generateEmbedding('test')).rejects.toThrow('OpenAI API error');
    });
  });

  describe('searchRoles', () => {
    it('should return search results sorted by similarity', async () => {
      const mockQueryEmbedding = [1, 0, 0];
      const mockRoleEmbeddings = [
        {
          roleKey: 'roles.role-1',
          description: 'Frontend Developer with React',
          embedding: [0.9, 0.1, 0], // Higher similarity
          metadata: { title: 'Frontend Developer' },
        },
        {
          roleKey: 'roles.role-2',
          description: 'Backend Developer',
          embedding: [0, 1, 0], // Lower similarity
          metadata: { title: 'Backend Developer' },
        },
      ];

      // Mock generateEmbedding
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockQueryEmbedding }],
        }),
      });

      const results = await engine.searchRoles(
        'React developer',
        mockRoleEmbeddings,
        { minSimilarity: 0 }
      );

      expect(results.length).toBe(2);
      expect(results[0].roleKey).toBe('roles.role-1'); // Higher similarity first
      expect(results[1].roleKey).toBe('roles.role-2');
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('should filter results by minimum similarity', async () => {
      const mockQueryEmbedding = [1, 0, 0];
      const mockRoleEmbeddings = [
        {
          roleKey: 'roles.role-1',
          description: 'Frontend Developer',
          embedding: [1, 0, 0],
        },
        {
          roleKey: 'roles.role-2',
          description: 'Backend Developer',
          embedding: [0, 1, 0],
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockQueryEmbedding }],
        }),
      });

      const results = await engine.searchRoles(
        'developer',
        mockRoleEmbeddings,
        { minSimilarity: 0.5 }
      );

      expect(results.length).toBe(1);
      expect(results[0].roleKey).toBe('roles.role-1');
    });

    it('should limit results to maxResults', async () => {
      const mockQueryEmbedding = new Array(1536).fill(0.5);
      const mockRoleEmbeddings = Array(10)
        .fill(null)
        .map((_, i) => ({
          roleKey: `roles.role-${i}`,
          description: `Role ${i}`,
          embedding: new Array(1536).fill(0.5),
        }));

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockQueryEmbedding }],
        }),
      });

      const results = await engine.searchRoles(
        'test',
        mockRoleEmbeddings,
        { maxResults: 3, minSimilarity: 0 }
      );

      expect(results.length).toBe(3);
    });

    it('should extract roleId from roleKey', async () => {
      const mockQueryEmbedding = new Array(1536).fill(0.5);
      const mockRoleEmbeddings = [
        {
          roleKey: 'roles.custom-role-123',
          description: 'Test Role',
          embedding: new Array(1536).fill(0.5),
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockQueryEmbedding }],
        }),
      });

      const results = await engine.searchRoles(
        'test',
        mockRoleEmbeddings,
        { minSimilarity: 0 }
      );

      expect(results[0].roleId).toBe('custom-role-123');
      expect(results[0].roleKey).toBe('roles.custom-role-123');
    });
  });

  describe('findSimilarRoles', () => {
    it('should find similar roles', async () => {
      const targetRole = {
        id: 'role-1',
        embedding: [1, 0, 0],
      };

      const allRoles = [
        targetRole,
        { id: 'role-2', embedding: [0.9, 0.1, 0] }, // Similar
        { id: 'role-3', embedding: [0, 1, 0] }, // Orthogonal
      ];

      const results = await engine.findSimilarRoles('role-1', allRoles, {
        minSimilarity: 0.5,
      });

      expect(results.length).toBe(1);
      expect(results[0].roleId).toBe('role-2');
      expect(results[0].similarity).toBeGreaterThan(0.5);
    });

    it('should exclude target role from results', async () => {
      const targetRole = {
        id: 'role-1',
        embedding: [1, 0, 0],
      };

      const results = await engine.findSimilarRoles('role-1', [targetRole], {});

      expect(results.length).toBe(0);
    });

    it('should return empty array if target role not found', async () => {
      const results = await engine.findSimilarRoles('nonexistent', [], {});
      expect(results.length).toBe(0);
    });
  });

  describe('batchSearch', () => {
    it('should search multiple queries', async () => {
      const mockQueryEmbedding = new Array(1536).fill(0.5);
      const mockRoleEmbeddings = [
        {
          roleKey: 'roles.role-1',
          description: 'Frontend Developer',
          embedding: new Array(1536).fill(0.5),
        },
      ];

      // Mock two API calls for two queries
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ embedding: mockQueryEmbedding }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ embedding: mockQueryEmbedding }],
          }),
        });

      const queries = ['React developer', 'TypeScript expert'];
      const results = await engine.batchSearch(queries, mockRoleEmbeddings, {
        minSimilarity: 0,
      });

      expect(results.size).toBe(2);
      expect(results.has('React developer')).toBe(true);
      expect(results.has('TypeScript expert')).toBe(true);
    });
  });
});
