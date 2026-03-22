import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import crypto from "crypto";

// Schema definitions
const VisibilitySchema = z.object({
    isPublic: z.boolean(),
    accessControl: z.enum(["public", "private", "team", "organization"])
});

const DisplaySchema = z.object({
    displayName: z.string(),
    shortDescription: z.string(),
    fullDescription: z.string().optional(),
    icon: z.string().url().optional(),
    screenshots: z.array(z.string().url()).optional(),
    readmeUrl: z.string().url().optional()
});

const MarketSchema = z.object({
    namespace: z.string(),
    category: z.enum([
        "coordination",
        "quality",
        "development",
        "analysis",
        "infrastructure",
        "education",
        "visualization",
        "testing",
        "institutional-workflow"
    ]),
    tags: z.array(z.string()),
    lifecycle: z.enum(["draft", "active", "deprecated", "archived"]).optional(),
    featured: z.boolean().optional(),
    curated: z.boolean().optional()
});

const GenomeSpecSchema = z.object({
    kind: z.literal("aha.agent.v1"),
    name: z.string(),
    runtime: z.enum(["claude", "codex"]),
    baseRoleId: z.string(),
    description: z.string().optional(),
    permissions: z.object({
        permissionMode: z.enum(["default", "yolo", "plan"]),
        accessLevel: z.enum(["read-only", "full-access"]).optional()
    }).optional(),
    tools: z.object({
        allowed: z.array(z.string()).optional(),
        disallowed: z.array(z.string()).optional()
    }).optional()
}).passthrough(); // Allow additional fields

const CreateListingSchema = z.object({
    spec: GenomeSpecSchema,
    visibility: VisibilitySchema,
    display: DisplaySchema,
    market: MarketSchema,
    compatibility: z.object({
        minAhaVersion: z.string().optional(),
        supportedRuntimes: z.array(z.enum(["claude", "codex"])).optional(),
        requiredFeatures: z.array(z.string()).optional()
    }).optional(),
    pricing: z.object({
        model: z.enum(["free", "paid", "subscription"]),
        details: z.any().optional()
    }).optional()
});

export function marketListingRoutes(app: Fastify) {
    // Create Listing API
    app.post('/v1/market/listings', {
        preHandler: app.authenticate,
        schema: {
            body: CreateListingSchema,
            response: {
                201: z.object({
                    listingId: z.string(),
                    ref: z.string(),
                    digest: z.string(),
                    status: z.literal("published"),
                    publishedAt: z.string()
                }),
                400: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal("Failed to create listing")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body as z.infer<typeof CreateListingSchema>;

        try {
            // Generate version number for this namespace+name
            const existingVersions = await db.marketListing.findMany({
                where: {
                    market: {
                        path: ['namespace'],
                        equals: body.market.namespace
                    },
                    // @ts-ignore - JSON path query
                    display: {
                        path: ['name'],
                        equals: body.spec.name
                    }
                },
                orderBy: { createdAt: 'desc' },
                take: 1
            });

            const version = existingVersions.length > 0 ? 1 : 1; // TODO: implement version increment

            // Generate digest from genome spec
            const digest = `sha256:${crypto
                .createHash('sha256')
                .update(JSON.stringify(body.spec))
                .digest('hex')}`;

            // Create ref: @namespace/name:version
            const ref = `${body.market.namespace}/${body.spec.name}:${version}`;

            // Create listing
            const listing = await db.marketListing.create({
                data: {
                    ref,
                    digest,
                    publisherId: userId!,
                    genome: body.spec as any,
                    visibility: body.visibility as any,
                    display: body.display as any,
                    market: {
                        ...body.market,
                        lifecycle: body.market.lifecycle || 'active'
                    } as any,
                    compatibility: body.compatibility as any || null,
                    pricing: body.pricing as any || null,
                    stats: {
                        downloads: 0,
                        activeInstances: 0,
                        starRating: 0,
                        reviewCount: 0
                    },
                    publishedAt: new Date()
                }
            });

            return reply.code(201).send({
                listingId: listing.id,
                ref: listing.ref,
                digest: listing.digest,
                status: "published",
                publishedAt: listing.publishedAt!.toISOString()
            });

        } catch (error) {
            log("Failed to create market listing:", error);
            return reply.code(500).send({ error: "Failed to create listing" });
        }
    });

    // Search Listings API
    app.get('/v1/market/listings', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                category: z.string().optional(),
                tags: z.string().optional(), // comma-separated
                namespace: z.string().optional(),
                search: z.string().optional(),
                sort: z.enum(["downloads", "starRating", "createdAt"]).optional(),
                limit: z.coerce.number().int().min(1).max(100).optional(),
                offset: z.coerce.number().int().min(0).optional()
            }),
            response: {
                200: z.object({
                    listings: z.array(z.object({
                        id: z.string(),
                        ref: z.string(),
                        displayName: z.string(),
                        shortDescription: z.string(),
                        category: z.string(),
                        tags: z.array(z.string()),
                        downloads: z.number(),
                        starRating: z.number(),
                        publisherId: z.string(),
                        createdAt: z.string()
                    })),
                    pagination: z.object({
                        total: z.number(),
                        offset: z.number(),
                        limit: z.number()
                    })
                }),
                500: z.object({
                    error: z.literal("Failed to search listings")
                })
            }
        }
    }, async (request, reply) => {
        const { category, tags, namespace, search, sort = "downloads", limit = 20, offset = 0 } = request.query as any;

        try {
            const where: any = {
                visibility: {
                    path: ['isPublic'],
                    equals: true
                }
            };

            // Add filters
            if (category) {
                where.market = { ...where.market, path: ['category'], equals: category };
            }

            if (namespace) {
                where.market = { ...where.market, path: ['namespace'], equals: namespace };
            }

            // Execute query
            const [listings, total] = await Promise.all([
                db.marketListing.findMany({
                    where,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    orderBy: (sort === "downloads"
                        ? { stats: { path: ['downloads'], sort: 'desc' } }
                        : sort === "starRating"
                        ? { stats: { path: ['starRating'], sort: 'desc' } }
                        : { createdAt: 'desc' }) as any,
                    skip: offset,
                    take: limit
                }),
                db.marketListing.count({ where })
            ]);

            return {
                listings: listings.map((l: any) => ({
                    id: l.id,
                    ref: l.ref,
                    displayName: (l.display as any).displayName,
                    shortDescription: (l.display as any).shortDescription,
                    category: (l.market as any).category,
                    tags: (l.market as any).tags || [],
                    downloads: (l.stats as any).downloads || 0,
                    starRating: (l.stats as any).starRating || 0,
                    publisherId: l.publisherId,
                    createdAt: l.createdAt.toISOString()
                })),
                pagination: {
                    total,
                    offset,
                    limit
                }
            };

        } catch (error) {
            log("Failed to search market listings:", error);
            return reply.code(500).send({ error: "Failed to search listings" });
        }
    });

    // Get Listing Details API
    app.get('/v1/market/listings/:ref', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                ref: z.string() // @namespace/name:version
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    ref: z.string(),
                    digest: z.string(),
                    genome: z.any(),
                    visibility: z.any(),
                    display: z.any(),
                    market: z.any(),
                    stats: z.any(),
                    compatibility: z.any().nullable(),
                    pricing: z.any().nullable(),
                    publisherId: z.string(),
                    publishedAt: z.string(),
                    createdAt: z.string(),
                    updatedAt: z.string()
                }),
                404: z.object({
                    error: z.literal("Listing not found")
                }),
                500: z.object({
                    error: z.literal("Failed to get listing")
                })
            }
        }
    }, async (request, reply) => {
        const { ref } = request.params as any;

        try {
            const listing = await db.marketListing.findUnique({
                where: { ref }
            });

            if (!listing) {
                return reply.code(404).send({ error: "Listing not found" });
            }

            return {
                id: listing.id,
                ref: listing.ref,
                digest: listing.digest,
                genome: listing.genome,
                visibility: listing.visibility,
                display: listing.display,
                market: listing.market,
                stats: listing.stats,
                compatibility: listing.compatibility,
                pricing: listing.pricing,
                publisherId: listing.publisherId,
                publishedAt: listing.publishedAt!.toISOString(),
                createdAt: listing.createdAt.toISOString(),
                updatedAt: listing.updatedAt.toISOString()
            };

        } catch (error) {
            log("Failed to get market listing:", error);
            return reply.code(500).send({ error: "Failed to get listing" });
        }
    });

    // Submit Review API
    app.post('/v1/market/listings/:listingId/reviews', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                listingId: z.string()
            }),
            body: z.object({
                rating: z.number().int().min(1).max(5),
                title: z.string().optional(),
                review: z.string().optional()
            }),
            response: {
                201: z.object({
                    reviewId: z.string(),
                    createdAt: z.string()
                }),
                400: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.literal("Listing not found")
                }),
                500: z.object({
                    error: z.literal("Failed to submit review")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { listingId } = request.params as any;
        const { rating, title, review } = request.body as any;

        try {
            // Verify listing exists
            const listing = await db.marketListing.findUnique({
                where: { id: listingId }
            });

            if (!listing) {
                return reply.code(404).send({ error: "Listing not found" });
            }

            // Check if user already reviewed
            const existingReview = await db.marketReview.findUnique({
                where: {
                    listingId_userId: {
                        listingId,
                        userId: userId!
                    }
                }
            });

            if (existingReview) {
                return reply.code(400).send({ error: "You have already reviewed this listing" });
            }

            // Create review
            const newReview = await db.marketReview.create({
                data: {
                    listingId,
                    userId: userId!,
                    rating,
                    title,
                    review
                }
            });

            // Update listing stats
            const allReviews = await db.marketReview.findMany({
                where: { listingId }
            });

            const avgRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

            await db.marketListing.update({
                where: { id: listingId },
                data: {
                    stats: {
                        ...(listing.stats as any),
                        starRating: avgRating,
                        reviewCount: allReviews.length
                    }
                }
            });

            return reply.code(201).send({
                reviewId: newReview.id,
                createdAt: newReview.createdAt.toISOString()
            });

        } catch (error) {
            log("Failed to submit review:", error);
            return reply.code(500).send({ error: "Failed to submit review" });
        }
    });
}
