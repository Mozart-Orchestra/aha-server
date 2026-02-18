import { Context } from "@/context";
import { FeedBody, UserFeedItem } from "./types";
import { afterTx, Tx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildNewFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

/**
 * Add a post to user's feed.
 * If repeatKey is provided and exists, the post will be updated in-place.
 * Otherwise, a new post is created with an incremented counter.
 */
export async function feedPost(
    tx: Tx,
    ctx: Context,
    body: FeedBody,
    repeatKey?: string | null
): Promise<UserFeedItem> {


    // Delete existing items with the same repeatKey
    if (repeatKey) {
        await tx.userFeedItem.deleteMany({
            where: {
                userId: ctx.uid,
                repeatKey: repeatKey
            }
        });
    }

    // Allocate new counter
    const current = await tx.account.findUniqueOrThrow({
        where: { id: ctx.uid },
        select: { feedSeq: true }
    });
    const newSeq = (parseInt(current.feedSeq, 10) + 1).toString();
    await tx.account.update({
        where: { id: ctx.uid },
        data: { feedSeq: newSeq }
    });

    // Create new item
    const item = await tx.userFeedItem.create({
        data: {
            counter: newSeq,
            userId: ctx.uid,
            repeatKey: repeatKey,
            body: body
        }
    });

    const result = {
        ...item,
        createdAt: item.createdAt.getTime(),
        cursor: '0-' + item.counter
    };

    // Emit socket event after transaction completes
    afterTx(tx, async () => {
        const updateSeq = await allocateUserSeq(ctx.uid);
        const updatePayload = buildNewFeedPostUpdate(result, updateSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId: ctx.uid,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
    });

    return result;
}