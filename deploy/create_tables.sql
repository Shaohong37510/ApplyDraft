-- ═══════════════════════════════════════════════════════════
-- ApplyDraft - Supabase Database Setup
-- Run this in Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- 1. User credits balance
CREATE TABLE IF NOT EXISTS user_credits (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    credits INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Credit transaction history
CREATE TABLE IF NOT EXISTS credit_transactions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
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

-- 4. RPC function to atomically increment credits
CREATE OR REPLACE FUNCTION increment_credits(uid UUID, amount INTEGER)
RETURNS void AS $$
BEGIN
    UPDATE user_credits SET credits = credits + amount WHERE user_id = uid;
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
