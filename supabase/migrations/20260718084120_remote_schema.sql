


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into profiles (id, full_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "phone" "text" NOT NULL,
    "mnc_registration" "text",
    "experience" "text",
    "speciality" "text",
    "message" "text",
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "city" "text",
    CONSTRAINT "applications_status_check" CHECK (("status" = ANY (ARRAY['submitted'::"text", 'reviewed'::"text", 'converted'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "nurse_id" "uuid",
    "payment_id" "text",
    "name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "email" "text",
    "care_type" "text",
    "service" "text",
    "location" "text",
    "scheduled_date" "date",
    "scheduled_time" "text",
    "notes" "text",
    "status" "text" DEFAULT 'pending_payment'::"text" NOT NULL,
    "amount_paise" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookings_status_check" CHECK (("status" = ANY (ARRAY['pending_payment'::"text", 'confirmed'::"text", 'assigned'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."callbacks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "preferred_time" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."callbacks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."invoice_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."invoice_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_number" "text" DEFAULT ((('CC360-INV-'::"text" || "to_char"("now"(), 'YYYY'::"text")) || '-'::"text") || "lpad"(("nextval"('"public"."invoice_number_seq"'::"regclass"))::"text", 5, '0'::"text")) NOT NULL,
    "booking_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "customer_id" "uuid",
    "subtotal_paise" integer NOT NULL,
    "tax_paise" integer DEFAULT 0 NOT NULL,
    "total_paise" integer NOT NULL,
    "status" "text" DEFAULT 'issued'::"text" NOT NULL,
    "pdf_url" "text",
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "invoices_status_check" CHECK (("status" = ANY (ARRAY['issued'::"text", 'paid'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."nurses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid",
    "first_name" "text" NOT NULL,
    "last_name" "text",
    "mnc_registration" "text",
    "speciality" "text",
    "experience" "text",
    "phone" "text",
    "email" "text",
    "status" "text" DEFAULT 'pending_verification'::"text" NOT NULL,
    "source_application_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "nurses_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'pending_verification'::"text"])))
);


ALTER TABLE "public"."nurses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "text" NOT NULL,
    "webhook_event_id" "text" NOT NULL,
    "booking_id" "uuid",
    "order_id" "text",
    "event_type" "text",
    "amount_paise" integer,
    "currency" "text" DEFAULT 'INR'::"text",
    "status" "text",
    "customer_email" "text",
    "customer_phone" "text",
    "customer_name" "text",
    "razorpay_notes" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "phone" "text",
    "avatar_url" "text",
    "role" "text" DEFAULT 'customer'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['customer'::"text", 'nurse'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."applications"
    ADD CONSTRAINT "applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_payment_id_key" UNIQUE ("payment_id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."callbacks"
    ADD CONSTRAINT "callbacks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_invoice_number_key" UNIQUE ("invoice_number");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nurses"
    ADD CONSTRAINT "nurses_mnc_registration_key" UNIQUE ("mnc_registration");



ALTER TABLE ONLY "public"."nurses"
    ADD CONSTRAINT "nurses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payment_id_key" UNIQUE ("payment_id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_webhook_event_id_key" UNIQUE ("webhook_event_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_bookings_customer" ON "public"."bookings" USING "btree" ("customer_id");



CREATE INDEX "idx_bookings_nurse" ON "public"."bookings" USING "btree" ("nurse_id");



CREATE INDEX "idx_bookings_payment" ON "public"."bookings" USING "btree" ("payment_id");



CREATE INDEX "idx_bookings_payment_id" ON "public"."bookings" USING "btree" ("payment_id");



CREATE INDEX "idx_invoices_customer" ON "public"."invoices" USING "btree" ("customer_id");



CREATE INDEX "idx_payments_booking" ON "public"."payments" USING "btree" ("booking_id");



CREATE INDEX "idx_payments_webhook" ON "public"."payments" USING "btree" ("webhook_event_id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "public"."nurses"("id");



ALTER TABLE ONLY "public"."callbacks"
    ADD CONSTRAINT "callbacks_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id");



ALTER TABLE ONLY "public"."nurses"
    ADD CONSTRAINT "nurses_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Patients can view own bookings" ON "public"."bookings" FOR SELECT USING (("auth"."uid"() = "customer_id"));



CREATE POLICY "Patients can view own invoices" ON "public"."invoices" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."bookings"
  WHERE (("bookings"."id" = "invoices"."booking_id") AND ("bookings"."customer_id" = "auth"."uid"())))));



CREATE POLICY "Public can submit applications" ON "public"."applications" FOR INSERT WITH CHECK (true);



CREATE POLICY "Public can submit callbacks" ON "public"."callbacks" FOR INSERT WITH CHECK (true);



ALTER TABLE "public"."applications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."callbacks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers view own bookings" ON "public"."bookings" FOR SELECT USING (("auth"."uid"() = "customer_id"));



CREATE POLICY "customers view own invoices" ON "public"."invoices" FOR SELECT USING (("auth"."uid"() = "customer_id"));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nurses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "nurses view assigned bookings" ON "public"."bookings" FOR SELECT USING (("nurse_id" IN ( SELECT "nurses"."id"
   FROM "public"."nurses"
  WHERE ("nurses"."profile_id" = "auth"."uid"()))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "users view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





































































































































































GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."applications" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."applications" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."applications" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookings" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookings" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookings" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."callbacks" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."callbacks" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."callbacks" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invoices" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invoices" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invoices" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."nurses" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."nurses" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."nurses" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."payments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."payments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."payments" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";



































drop extension if exists "pg_net";

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


