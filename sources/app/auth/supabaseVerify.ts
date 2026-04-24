import { createClient } from "@supabase/supabase-js";
import { log } from "@/utils/log";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseAdminClient: ReturnType<typeof createClient> | null = null;

function getSupabaseAdminClient(): ReturnType<typeof createClient> | null {
    if (!supabaseUrl || !supabaseServiceRoleKey) {
        log({ module: 'supabase-auth', level: 'error' }, 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
        return null;
    }

    if (!supabaseAdminClient) {
        supabaseAdminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });
    }

    return supabaseAdminClient;
}

/**
 * Verifies a Supabase access token and returns the authenticated user info.
 * Uses the Supabase admin client with service_role key to validate tokens server-side.
 */
export async function supabaseVerifyToken(accessToken: string): Promise<{
    supabaseUserId: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
} | null> {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
        return null;
    }

    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
        log({ module: 'supabase-auth' }, `Supabase token verification failed: ${error?.message ?? 'no user'}`);
        return null;
    }

    const user = data.user;
    const metadata = user.user_metadata ?? {};

    return {
        supabaseUserId: user.id,
        email: user.email ?? null,
        name: metadata.full_name ?? metadata.name ?? null,
        avatarUrl: metadata.avatar_url ?? null,
    };
}
