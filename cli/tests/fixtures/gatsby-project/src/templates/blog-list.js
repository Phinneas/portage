import React from "react";
import { graphql } from "gatsby";
import Layout from "../components/layout";

const BlogListTemplate = ({ data }) => {
  const posts = data.allMarkdownRemark.nodes;
  return (
    <Layout>
      <h1>Blog</h1>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.frontmatter.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </Layout>
  );
};

export default BlogListTemplate;

export const pageQuery = graphql`
  query BlogListQuery {
    allMarkdownRemark(sort: { frontmatter: { date: DESC } }) {
      nodes {
        id
        excerpt
        fields {
          slug
        }
        frontmatter {
          date(formatString: "MMMM DD, YYYY")
          title
          description
        }
      }
    }
  }
`;
