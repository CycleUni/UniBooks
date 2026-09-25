#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
until python -c "import psycopg; psycopg.connect(dbname='$POSTGRES_DATABASE', user='$POSTGRES_USER', password='$POSTGRES_PASSWORD', host='$POSTGRES_HOST', port='$DB_PORT', sslmode='disable')" 2>/dev/null; do
  sleep 1
done
echo "PostgreSQL is ready."

echo "Running migrations..."
python manage.py migrate --noinput

echo "Collecting static files..."
python manage.py collectstatic --noinput

echo "Starting Django dev server..."
python manage.py runserver 0.0.0.0:8000