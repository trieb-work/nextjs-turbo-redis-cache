import Link from 'next/link';

// Separate the client component into its own file
import { RevalidationInterface } from './revalidation-interface';

export default function HomePage() {
  return (
    <main
      style={{
        padding: '40px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: '1200px',
        margin: '0 auto',
        color: '#333',
      }}
    >
      <header
        style={{
          borderBottom: '2px solid #0070f3',
          paddingBottom: '20px',
          marginBottom: '30px',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '2.5rem',
            color: '#0070f3',
            margin: '0 0 16px 0',
          }}
        >
          Next.js Redis Cache Testing
        </h1>
        <p
          style={{
            fontSize: '1.2rem',
            color: '#666',
            maxWidth: '800px',
            margin: '0 auto',
          }}
        >
          This is a test application for the nextjs-turbo-redis-cache package,
          demonstrating various caching strategies.
        </p>
      </header>

      <section style={{ marginBottom: '40px' }}>
        <h2
          style={{
            fontSize: '1.8rem',
            borderLeft: '5px solid #0070f3',
            paddingLeft: '15px',
            color: '#0070f3',
            marginBottom: '25px',
          }}
        >
          Pages
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '25px',
          }}
        >
          {/* Cached Static Fetch Pages */}
          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              Cached Static Fetch
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              <strong>API Route:</strong> <code>/api/cached-static-fetch</code>
              <br />
              These pages fetch data from the cached static API route with{' '}
              <code>force-static</code> and <code>revalidate: false</code>{' '}
              settings.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/cached-static-fetch/default--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Default + Force Dynamic
                </Link>
              </li>
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/cached-static-fetch/revalidate15--default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Default
                </Link>
              </li>
              <li>
                <Link
                  href="/pages/cached-static-fetch/revalidate15--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Force Dynamic
                </Link>
              </li>
            </ul>
          </div>

          {/* No Fetch Pages */}
          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              No Fetch
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              <strong>API Route:</strong> None
              <br />
              These pages don&apos;t make any API requests and are statically
              generated without external data.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li>
                <Link
                  href="/pages/no-fetch/default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Default Page
                </Link>
              </li>
            </ul>
          </div>

          {/* Revalidated Fetch Pages */}
          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              Revalidated Fetch
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              <strong>API Route:</strong> <code>/api/revalidated-fetch</code>
              <br />
              These pages fetch data from the revalidated API route with{' '}
              <code>revalidate: 5</code> setting, causing automatic revalidation
              after 5 seconds.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/revalidated-fetch/default--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Default + Force Dynamic
                </Link>
              </li>
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/revalidated-fetch/revalidate15--default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Default
                </Link>
              </li>
              <li>
                <Link
                  href="/pages/revalidated-fetch/revalidate15--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Force Dynamic
                </Link>
              </li>
            </ul>
          </div>

          {/* Uncached Fetch Pages */}
          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              Uncached Fetch
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              <strong>API Route:</strong> <code>/api/uncached-fetch</code>
              <br />
              These pages fetch data from the uncached API route with{' '}
              <code>dynamic: &apos;force-dynamic&apos;</code> setting, causing a
              new fetch on every request.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/uncached-fetch/default--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Default + Force Dynamic
                </Link>
              </li>
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/pages/uncached-fetch/revalidate15--default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Default
                </Link>
              </li>
              <li>
                <Link
                  href="/pages/uncached-fetch/revalidate15--force-dynamic-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate 15s + Force Dynamic
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: '40px' }}>
        <h2
          style={{
            fontSize: '1.8rem',
            borderLeft: '5px solid #0070f3',
            paddingLeft: '15px',
            color: '#0070f3',
            marginBottom: '25px',
          }}
        >
          API Routes
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '25px',
          }}
        >
          {/* API Routes */}
          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              Cache Control APIs
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              These API routes demonstrate different caching behaviors. Each
              returns a counter value that increases on each uncached request.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/api/cached-static-fetch"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Cached Static Fetch
                </Link>
              </li>
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/api/uncached-fetch"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Uncached Fetch
                </Link>
              </li>
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/api/revalidated-fetch"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidated Fetch
                </Link>
              </li>
              <li>
                <Link
                  href="/api/nested-fetch-in-api-route"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Nested Fetch in API Route
                </Link>
              </li>
            </ul>
          </div>

          <div
            style={{
              border: '1px solid #eaeaea',
              padding: '25px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              backgroundColor: '#fff',
            }}
          >
            <h3
              style={{
                fontSize: '1.4rem',
                color: '#0070f3',
                marginTop: '0',
                marginBottom: '15px',
                borderBottom: '1px solid #eaeaea',
                paddingBottom: '10px',
              }}
            >
              Revalidation APIs
            </h3>
            <div
              style={{
                backgroundColor: '#f0f7ff',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '15px',
                fontSize: '0.9rem',
                borderLeft: '3px solid #0070f3',
              }}
            >
              These API routes allow on-demand revalidation of cached content
              using either path-based or tag-based approaches.
            </div>
            <ul
              style={{
                listStyleType: 'none',
                padding: '0',
                margin: '0',
              }}
            >
              <li style={{ marginBottom: '12px' }}>
                <Link
                  href="/api/revalidatePath?path=/pages/revalidated-fetch/revalidate15--default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate Path
                </Link>
              </li>
              <li>
                <Link
                  href="/api/revalidateTag?tag=cached-static-fetch-revalidate15-default-page"
                  style={{
                    display: 'block',
                    padding: '10px 15px',
                    backgroundColor: '#f4f7ff',
                    borderRadius: '5px',
                    color: '#0070f3',
                    textDecoration: 'none',
                    fontWeight: '500',
                    transition: 'background-color 0.2s',
                  }}
                >
                  Revalidate Tag
                </Link>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: '40px' }}>
        <h2
          style={{
            fontSize: '1.8rem',
            borderLeft: '5px solid #0070f3',
            paddingLeft: '15px',
            color: '#0070f3',
            marginBottom: '25px',
          }}
        >
          Revalidation Interface
        </h2>
        <RevalidationInterface />
      </section>

      <section style={{ marginBottom: '40px' }}>
        <h2
          style={{
            fontSize: '1.8rem',
            borderLeft: '5px solid #0070f3',
            paddingLeft: '15px',
            color: '#0070f3',
            marginBottom: '25px',
          }}
        >
          Cache Testing Tools
        </h2>
        <div
          style={{
            border: '1px solid #eaeaea',
            padding: '25px',
            borderRadius: '8px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
            backgroundColor: '#fff',
          }}
        >
          <p
            style={{
              fontSize: '1.1rem',
              lineHeight: '1.6',
              color: '#555',
              marginTop: '0',
            }}
          >
            Use these links to test various caching scenarios. Each link
            demonstrates different caching behaviors:
          </p>
          <ul
            style={{
              paddingLeft: '20px',
              color: '#555',
              lineHeight: '1.6',
            }}
          >
            <li style={{ marginBottom: '10px' }}>
              <strong style={{ color: '#0070f3' }}>Cached Static Fetch</strong>:
              Demonstrates static caching with no revalidation
            </li>
            <li style={{ marginBottom: '10px' }}>
              <strong style={{ color: '#0070f3' }}>Revalidated Fetch</strong>:
              Shows how data is revalidated after a specified time
            </li>
            <li style={{ marginBottom: '10px' }}>
              <strong style={{ color: '#0070f3' }}>Uncached Fetch</strong>:
              Shows dynamic data fetching without caching
            </li>
            <li>
              <strong style={{ color: '#0070f3' }}>Revalidate Path/Tag</strong>:
              Demonstrates on-demand revalidation
            </li>
          </ul>
          <div
            style={{
              backgroundColor: '#f9f9f9',
              padding: '15px',
              borderRadius: '5px',
              borderLeft: '4px solid #0070f3',
              marginTop: '20px',
            }}
          >
            <p
              style={{
                fontSize: '1.1rem',
                margin: '0',
                color: '#555',
              }}
            >
              <strong>Testing Tip:</strong> Try visiting a page, then triggering
              revalidation using the API routes, and observe how the counter
              values change.
            </p>
          </div>
        </div>
      </section>

      <footer
        style={{
          marginTop: '60px',
          textAlign: 'center',
          color: '#666',
          borderTop: '1px solid #eaeaea',
          paddingTop: '20px',
        }}
      >
        <p>nextjs-turbo-redis-cache testing application</p>
      </footer>
    </main>
  );
}
