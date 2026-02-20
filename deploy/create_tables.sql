-- ═══════════════════════════════════════════════════════════
-- ApplyDraft - Supabase Database Setup
-- Run this in Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. User credits balance
CREATE TABLE IF NOT EXISTS user_credits (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    credits NUMERIC(12,3) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Credit transaction history
CREATE TABLE IF NOT EXISTS credit_transactions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    amount NUMERIC(12,3) NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    stripe_session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. User settings (email config etc.)
CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email_provider TEXT DEFAULT 'none',
    gmail_email TEXT DEFAULT '',
    gmail_app_password TEXT DEFAULT '',
    outlook_tokens JSONB,
    outlook_email TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. RPC: increment credits (purchases/bonuses)
CREATE OR REPLACE FUNCTION increment_credits(uid UUID, amount NUMERIC)
RETURNS void AS $$
BEGIN
    UPDATE user_credits SET credits = credits + amount WHERE user_id = uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4b. RPC: atomically deduct credits — returns TRUE if ok, FALSE if insufficient
CREATE OR REPLACE FUNCTION use_credits_safe(uid UUID, amount NUMERIC)
RETURNS BOOLEAN AS $$
DECLARE
    current_balance NUMERIC;
BEGIN
    SELECT credits INTO current_balance
    FROM user_credits
    WHERE user_id = uid
    FOR UPDATE;

    IF current_balance IS NULL OR current_balance < amount THEN
        RETURN FALSE;
    END IF;

    UPDATE user_credits SET credits = credits - amount WHERE user_id = uid;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Enable Row Level Security
ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- 6. RLS policies (service key bypasses RLS, so backend works fine)
CREATE POLICY "Users can view own credits" ON user_credits FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own transactions" ON credit_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own settings" ON user_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own settings" ON user_settings FOR UPDATE USING (auth.uid() = user_id);
