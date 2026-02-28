/**
 * V5-UX-002: Intelligent Search API
 *
 * Endpoints:
 * - POST /api/v5/search/roles - Semantic search for roles
 * - POST /api/v5/search/index - Index role for search
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SemanticSearchEngine, SearchResult, SearchOptions } from '../../../services/ai/SemanticSearchEngine';
import { kvList } from '@/app/kv/kvList';
import { kvGet } from '@/app/kv/kvGet';
import { log } from '@/utils/log';
import { db } from '@/storage/db';

// Request schemas
const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().min(1).max(20).default(5),
  minSimilarity: z.number().min(0).max(1).default(0.5),
  includeMetadata: z.boolean().default(true),
});

const IndexRoleRequestSchema = z.object({
  roleKey: z.string(),
  description: z.string(),
  metadata: z.object({
    title: z.string().optional(),
    category: z.string().optional(),
    skills: z.array(z.string()).optional(),
  }).optional(),
});

export async function searchRoutes(fastify: FastifyInstance) {
  const searchEngine = new SemanticSearchEngine();

  /**
   * POST /api/v5/search/roles
   *
   * Semantic search for roles using vector similarity
   */
  fastify.post('/api/v5/search/roles', {
    schema: {
      body: SearchRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          results: z.array(z.object({
            roleKey: z.string(),
            roleId: z.string(),
            similarity: z.number(),
            description: z.string(),
            metadata: z.object({
              title: z.string().optional(),
              category: z.string().optional(),
              skills: z.array(z.string()).optional(),
            }).optional(),
          })),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as z.infer<typeof SearchRequestSchema>;
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          results: [],
          error: 'Unauthorized',
        });
      }

      // Load role embeddings from database (in production, use pgvector)
      const embeddingRecords = await db.roleEmbedding.findMany({
        where: { accountId: userId },
      });

      if (embeddingRecords.length === 0) {
        // No indexed roles - return empty results
        return {
          success: true,
          results: [],
        };
      }

      // Parse embeddings from JSON strings
      const roleEmbeddings = embeddingRecords.map(record => ({
        roleKey: record.roleKey,
        description: record.description,
        embedding: JSON.parse(record.embedding),
        metadata: record.description, // TODO: Store metadata separately
      }));

      // Perform semantic search
      const searchOptions: SearchOptions = {
        maxResults: body.maxResults,
        minSimilarity: body.minSimilarity,
        includeMetadata: body.includeMetadata,
      };

      const results = await searchEngine.searchRoles(
        body.query,
        roleEmbeddings,
        searchOptions
      );

      return {
        success: true,
        results,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        results: [],
        error: 'Search failed',
      });
    }
  });

  /**
   * POST /api/v5/search/index
   *
   * Index a role for semantic search
   */
  fastify.post('/api/v5/search/index', {
    schema: {
      body: IndexRoleRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as z.infer<typeof IndexRoleRequestSchema>;
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized',
        });
      }

      // Generate embedding for role description
      const embedding = await searchEngine.generateEmbedding(body.description);

      // Store embedding in database
      await db.roleEmbedding.upsert({
        where: {
          accountId_roleKey: {
            accountId: userId,
            roleKey: body.roleKey,
          },
        },
        create: {
          accountId: userId,
          roleKey: body.roleKey,
          description: body.description,
          embedding: JSON.stringify(embedding),
        },
        update: {
          description: body.description,
          embedding: JSON.stringify(embedding),
        },
      });

      return {
        success: true,
        message: 'Role indexed successfully',
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Indexing failed',
      });
    }
  });

  /**
   * POST /api/v5/search/index-all
   *
   * Index all roles for a user (batch operation)
   */
  fastify.post('/api/v5/search/index-all', {
    schema: {
      response: {
        200: z.object({
          success: z.boolean(),
          indexed: z.number(),
          message: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          indexed: 0,
          message: 'Unauthorized',
        });
      }

      // Load all roles from KV store
      const ROLES_PREFIX = "roles.";
      const roleItems = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });

      let indexedCount = 0;

      for (const item of roleItems.items) {
        try {
          const role = JSON.parse(item.value);
          const searchableText = searchEngine.extractSearchableText(role);

          // Generate embedding
          const embedding = await searchEngine.generateEmbedding(searchableText);

          // Store in database
          await db.roleEmbedding.upsert({
            where: {
              accountId_roleKey: {
                accountId: userId,
                roleKey: item.key,
              },
            },
            create: {
              accountId: userId,
              roleKey: item.key,
              description: searchableText,
              embedding: JSON.stringify(embedding),
            },
            update: {
              description: searchableText,
              embedding: JSON.stringify(embedding),
            },
          });

          indexedCount++;
        } catch (e) {
          // Skip roles that fail to parse or index
          log(`Failed to index role ${item.key}: ${e}`);
        }
      }

      return {
        success: true,
        indexed: indexedCount,
        message: `Indexed ${indexedCount} roles successfully`,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        indexed: 0,
        message: 'Batch indexing failed',
      });
    }
  });

  /**
   * DELETE /api/v5/search/index/:roleKey
   *
   * Remove a role from the search index
   */
  fastify.delete('/api/v5/search/index/:roleKey', {
    schema: {
      params: z.object({
        roleKey: z.string(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const { roleKey } = request.params as { roleKey: string };
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized',
        });
      }

      await db.roleEmbedding.delete({
        where: {
          accountId_roleKey: {
            accountId: userId,
            roleKey,
          },
        },
      });

      return {
        success: true,
        message: 'Role removed from index',
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to remove role from index',
      });
    }
  });
}
