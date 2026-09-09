import { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { getSaasBlogPosts } from '../data/coreStore';
import { BookIcon, SparklesIcon, RocketIcon, TeacherIcon, ChartBarIcon, PrintIcon } from '../components/CommonIcons';
import { Helmet } from 'react-helmet-async';
import './Blog.css';

export default function Blog() {
  const [posts, setPosts] = useState([]);
  const [filter, setFilter] = useState('All');
  const [selectedPost, setSelectedPost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const data = await getSaasBlogPosts();
      setPosts(data);
      setLoading(false);
    };
    load();
  }, []);

  const categories = ['All', 'Feature Deep-Dives', 'Product Updates', 'Educational Leadership'];
  const filteredPosts = filter === 'All' ? posts : posts.filter(p => p.category === filter);

  if (selectedPost) {
    return (
      <div className="blog-reader animate-in">
        <button className="btn btn-ghost mb-20" onClick={() => setSelectedPost(null)}>← Back to Blog</button>
        <article className="post-full">
          <header className="post-header">
            <span className="post-badge">{selectedPost.category}</span>
            <h1 className="post-title-full">{selectedPost.title}</h1>
            <div className="post-meta">
              <span>By {selectedPost.author}</span> • <span>{new Date(selectedPost.date).toLocaleDateString()}</span> • <span>{selectedPost.readTime}</span>
            </div>
          </header>
          {selectedPost.image && <img src={selectedPost.image} alt={selectedPost.title} className="post-hero-image" />}
          <div className="post-content" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedPost.content) }} />
          
          <footer className="post-footer">
            <div className="cta-box">
              <h3>Start your journey with Termly today</h3>
              <p>Join over 500 schools transforming their management experience.</p>
              <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                <a href="/book-demo" className="btn btn-primary">Book a Demo</a>
                <button className="btn btn-ghost">Contact Sales</button>
              </div>
            </div>
          </footer>
        </article>
      </div>
    );
  }

  return (
    <div className="blog-container animate-in">
      <Helmet>
        <title>Blog | Termly Insights — Education Technology in Kenya</title>
        <meta name="description" content="Discover how modern technology is transforming schools across Kenya. Feature deep-dives, product updates, and educational leadership insights." />
        <meta name="keywords" content="Termly blog, Kenya education technology, CBC updates, school management" />
        <link rel="canonical" href="https://Termly.com/blog" />
      </Helmet>
      <header className="blog-hero">
        <h1 className="hero-title">Termly <span className="text-gradient">Insights</span></h1>
        <p className="hero-subtitle">Discover how modern technology is transforming schools across the continent.</p>
      </header>

      <div className="blog-filters">
        {categories.map(c => (
          <button 
            key={c} 
            className={`filter-chip ${filter === c ? 'active' : ''}`}
            onClick={() => setFilter(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="blog-loading">
          <div className="spinner"></div>
          <p>Loading the latest updates...</p>
        </div>
      ) : (
        <div className="blog-grid">
          {filteredPosts.map(post => (
            <div key={post.id} className="blog-card" onClick={() => setSelectedPost(post)}>
              <div className="card-image-wrapper">
                <img src={post.image || 'https://images.unsplash.com/photo-1546410531-bb4caa1b424d?auto=format&fit=crop&w=800&q=80'} alt={post.title} />
                <span className="card-badge">{post.category}</span>
              </div>
              <div className="card-body">
                <h3 className="post-title">{post.title}</h3>
                <p className="post-excerpt">{post.excerpt}</p>
                <div className="post-footer-meta">
                  <span className="author">{post.author}</span>
                  <span className="read-time">{post.readTime}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="featured-features">
        <h2 className="section-title">Core Modules</h2>
        <div className="feature-small-grid">
          <div className="f-item"><ChartBarIcon size={24} /> <span>Automatic Financials</span></div>
          <div className="f-item"><BookIcon size={24} /> <span>CBC Grading</span></div>
          {/* <div className="f-item"><RocketIcon size={24} /> <span>Smart Timetables</span></div> */}
          <div className="f-item"><TeacherIcon size={24} /> <span>Leave Management</span></div>
          <div className="f-item"><PrintIcon size={24} /> <span>Digital Reporting</span></div>
          <div className="f-item"><SparklesIcon size={24} /> <span>M-Pesa Sync</span></div>
        </div>
      </section>
    </div>
  );
}
