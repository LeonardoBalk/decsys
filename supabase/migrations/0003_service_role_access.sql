grant usage on schema public, core, municipal to service_role;
grant all privileges on all tables in schema public, core, municipal to service_role;
grant usage, select on all sequences in schema public, core, municipal to service_role;
grant execute on all functions in schema public, core, municipal to service_role;

alter default privileges for role postgres in schema public grant all privileges on tables to service_role;
alter default privileges for role postgres in schema core grant all privileges on tables to service_role;
alter default privileges for role postgres in schema municipal grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema core grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema municipal grant usage, select on sequences to service_role;
