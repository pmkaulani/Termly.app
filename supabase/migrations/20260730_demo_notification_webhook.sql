-- ============================================================
-- 20260730_demo_notification_webhook.sql
--
-- Sets up a database webhook to call the `notify-demo-request`
-- edge function automatically whenever a new row is inserted
-- into the `demo_requests` table.
-- ============================================================

-- Drop the trigger if it already exists to be safe
DROP TRIGGER IF EXISTS notify_demo_request_trigger ON public.demo_requests;

-- Create the trigger using the standard net.http_request_v2 function
-- Note: Replace the URL placeholder with your actual project's edge function URL 
-- or rely on the local pg_net setup if running locally. For production, it's typically:
-- https://<project-ref>.supabase.co/functions/v1/notify-demo-request

CREATE TRIGGER notify_demo_request_trigger
AFTER INSERT ON public.demo_requests
FOR EACH ROW
EXECUTE FUNCTION supabase_functions.http_request(
    'http://supabase_kong_Termly:8000/functions/v1/notify-demo-request',
    'POST',
    '{"Content-Type":"application/json", "x-webhook-secret":"local-dev-secret-12345"}',
    '{}',
    '1000'
);

-- Note about the URL above: 
-- Locally: http://supabase_kong_Termly:8000/functions/v1/notify-demo-request (or http://kong:8000 depending on your docker setup)
-- In production, the CLI's `supabase migrations up` doesn't automatically inject the project URL. 
-- The recommended Supabase approach for webhooks is to set them up via the Supabase Dashboard UI 
-- (Database -> Webhooks). However, if defining via SQL, ensure the correct URL is mapped.
-- To make this migration entirely generic for both local and prod, we use a pg_net request with a parameterized endpoint if possible.
-- For now, this points to the local/docker-internal network URL.
