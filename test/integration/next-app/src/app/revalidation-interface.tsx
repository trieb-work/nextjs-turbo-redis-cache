'use client';

import { useState } from 'react';

// Define API routes for path-based revalidation
const apiRoutePaths: Record<string, string> = {
  'Cached Static Fetch': '/api/cached-static-fetch',
  'Uncached Fetch': '/api/uncached-fetch',
  'Revalidated Fetch': '/api/revalidated-fetch',
  'Nested Fetch in API Route':
    '/api/nested-fetch-in-api-route/revalidated-fetch',
};

// Define API routes with tags for tag-based revalidation
const apiRouteTags: Record<string, string> = {
  'Revalidated Fetch in Nested API Route':
    'revalidated-fetch-revalidate15-nested-fetch-in-api-route',
  'Revalidated Fetch API': 'revalidated-fetch-api',
  'Cached Static Fetch API': 'cached-static-fetch-api',
  'Uncached Fetch API': 'uncached-fetch-api',
};

// Revalidation Interface Component
export function RevalidationInterface() {
  const [selectedPathRoute, setSelectedPathRoute] = useState('');
  const [selectedTagRoute, setSelectedTagRoute] = useState('');
  const [revalidationStatus, setRevalidationStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handlePathRevalidate = async () => {
    if (!selectedPathRoute) {
      setRevalidationStatus('Please select an API route to revalidate by path');
      return;
    }

    setIsLoading(true);
    setRevalidationStatus('Revalidating API route by path...');

    try {
      const path = apiRoutePaths[selectedPathRoute];
      const response = await fetch(`/api/revalidatePath?path=${path}`);
      const data = await response.json();

      if (response.ok) {
        setRevalidationStatus(
          `Successfully revalidated API route by path: ${selectedPathRoute} (${path})`,
        );
      } else {
        setRevalidationStatus(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      setRevalidationStatus(`Error: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTagRevalidate = async () => {
    if (!selectedTagRoute) {
      setRevalidationStatus('Please select an API route to revalidate by tag');
      return;
    }

    setIsLoading(true);
    setRevalidationStatus('Revalidating API route by tag...');

    try {
      const tag = apiRouteTags[selectedTagRoute];
      const response = await fetch(`/api/revalidateTag?tag=${tag}`);
      const data = await response.json();

      if (response.ok) {
        setRevalidationStatus(
          `Successfully revalidated API route by tag: ${selectedTagRoute} (tag: ${tag})`,
        );
      } else {
        setRevalidationStatus(`Error: ${data.error || 'Unknown error'}`);
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      setRevalidationStatus(`Error: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid #eaeaea',
        padding: '25px',
        borderRadius: '8px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
        backgroundColor: '#fff',
        marginBottom: '30px',
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
        API Route Revalidation Interface
      </h3>

      {/* Path-based revalidation section */}
      <div
        style={{
          padding: '15px',
          marginBottom: '20px',
          backgroundColor: '#f9f9f9',
          borderRadius: '5px',
          border: '1px solid #eaeaea',
        }}
      >
        <h4
          style={{
            fontSize: '1.1rem',
            color: '#0070f3',
            marginTop: '0',
            marginBottom: '15px',
          }}
        >
          Revalidate API Route by Path
        </h4>

        <div style={{ marginBottom: '15px' }}>
          <label
            style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}
          >
            Select API Route:
          </label>
          <select
            value={selectedPathRoute}
            onChange={(e) => setSelectedPathRoute(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '5px',
              border: '1px solid #ddd',
              fontSize: '1rem',
            }}
          >
            <option value="">-- Select an API route --</option>
            {Object.keys(apiRoutePaths).map((route) => (
              <option key={route} value={route}>
                {route}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handlePathRevalidate}
          disabled={isLoading || !selectedPathRoute}
          style={{
            backgroundColor: '#0070f3',
            color: 'white',
            border: 'none',
            padding: '10px 20px',
            borderRadius: '5px',
            fontSize: '1rem',
            fontWeight: '500',
            cursor: isLoading || !selectedPathRoute ? 'not-allowed' : 'pointer',
            opacity: isLoading || !selectedPathRoute ? 0.7 : 1,
            transition: 'all 0.2s',
          }}
        >
          {isLoading ? 'Revalidating...' : 'Revalidate by Path'}
        </button>
      </div>

      {/* Tag-based revalidation section */}
      <div
        style={{
          padding: '15px',
          marginBottom: '20px',
          backgroundColor: '#f9f9f9',
          borderRadius: '5px',
          border: '1px solid #eaeaea',
        }}
      >
        <h4
          style={{
            fontSize: '1.1rem',
            color: '#0070f3',
            marginTop: '0',
            marginBottom: '15px',
          }}
        >
          Revalidate API Route by Tag
        </h4>

        <div style={{ marginBottom: '15px' }}>
          <label
            style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}
          >
            Select API Route with Tag:
          </label>
          <select
            value={selectedTagRoute}
            onChange={(e) => setSelectedTagRoute(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '5px',
              border: '1px solid #ddd',
              fontSize: '1rem',
            }}
          >
            <option value="">-- Select an API route with tag --</option>
            {Object.keys(apiRouteTags).map((route) => (
              <option key={route} value={route}>
                {route}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleTagRevalidate}
          disabled={isLoading || !selectedTagRoute}
          style={{
            backgroundColor: '#0070f3',
            color: 'white',
            border: 'none',
            padding: '10px 20px',
            borderRadius: '5px',
            fontSize: '1rem',
            fontWeight: '500',
            cursor: isLoading || !selectedTagRoute ? 'not-allowed' : 'pointer',
            opacity: isLoading || !selectedTagRoute ? 0.7 : 1,
            transition: 'all 0.2s',
          }}
        >
          {isLoading ? 'Revalidating...' : 'Revalidate by Tag'}
        </button>
      </div>

      {/* Status display */}
      {revalidationStatus && (
        <div
          style={{
            marginTop: '15px',
            padding: '10px',
            borderRadius: '5px',
            backgroundColor: revalidationStatus.includes('Error')
              ? '#ffebee'
              : '#e3f2fd',
            color: revalidationStatus.includes('Error') ? '#c62828' : '#0070f3',
            border: `1px solid ${revalidationStatus.includes('Error') ? '#ffcdd2' : '#bbdefb'}`,
          }}
        >
          {revalidationStatus}
        </div>
      )}
    </div>
  );
}
