import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile } from "@/app/social/type";

export async function userRoutes(app: Fastify) {

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                }),
                500: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const { id } = request.params;

            const user = await db.account.findUnique({
                where: { id },
                include: { githubUser: true }
            });

            if (!user) {
                return reply.code(404).send({ error: 'User not found' });
            }

            const relationship = await db.userRelationship.findFirst({
                where: { fromUserId: request.userId, toUserId: id }
            });
            const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

            return reply.send({ user: buildUserProfile(user, status) });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to fetch user profile' });
        }
    });

    // Search for users
    app.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string().min(2).max(50) // Security: Require minimum length to prevent expensive queries
            }),
            response: {
                200: z.object({
                    users: z.array(UserProfileSchema)
                }),
                500: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const { query } = request.query;

            const users = await db.account.findMany({
                where: { username: { startsWith: query } },
                include: { githubUser: true },
                take: 10,
                orderBy: { username: 'asc' }
            });

            const userIds = users.map(user => user.id);
            const relationships = userIds.length > 0
                ? await db.userRelationship.findMany({
                    where: { fromUserId: request.userId, toUserId: { in: userIds } }
                })
                : [];

            const relationshipMap = new Map(
                relationships.map(rel => [rel.toUserId, rel.status])
            );

            const userProfiles = users.map((user) => {
                const status = relationshipMap.get(user.id) || RelationshipStatus.none;
                return buildUserProfile(user as typeof user & { githubUser: { profile: any } | null }, status);
            });

            return reply.send({ users: userProfiles });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to search users' });
        }
    });

    // Add friend
    app.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                }),
                500: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const user = await friendAdd(Context.create(request.userId), request.body.uid);
            return reply.send({ user });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to add friend' });
        }
    });

    app.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                }),
                500: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const user = await friendRemove(Context.create(request.userId), request.body.uid);
            return reply.send({ user });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to remove friend' });
        }
    });

    app.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                }),
                500: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            const friends = await friendList(Context.create(request.userId));
            return reply.send({ friends });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to list friends' });
        }
    });
};

// Shared Zod Schemas
const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: RelationshipStatusSchema
});
