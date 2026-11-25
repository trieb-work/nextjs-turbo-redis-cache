import type { GetStaticProps } from 'next';

type Props = { timestamp: number };

export default function StaticForever({ timestamp }: Props) {
  return (
    <main>
      <h1>Static forever</h1>
      <p>Timestamp: {timestamp}</p>
    </main>
  );
}

// revalidate is intentionally omitted (revalidate: false): the cache entry
// must fall through to the defaultStaleAge based TTL in the cache handler.
export const getStaticProps: GetStaticProps<Props> = async () => {
  return {
    props: { timestamp: Date.now() },
  };
};
