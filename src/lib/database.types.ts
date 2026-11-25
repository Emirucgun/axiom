/**
 * Typed schema for supabase/migrations/001_initial_schema.sql + 002_byok_api_keys.sql.
 *
 * Hand-maintained to match the migration. Once your project is linked you can
 * regenerate it with:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type StudyAttemptMode = 'level_climb' | 'first_2_lines' | 'feynman';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          mastery_elo: number;
          daily_streak: number;
          last_study_date: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          mastery_elo?: number;
          daily_streak?: number;
          last_study_date?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
        Relationships: [];
      };
      courses: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          combined_syllabus_summary: string | null;
          code: string;
          exam_date: string | null;
          detected_language: string;
          course_digest: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          combined_syllabus_summary?: string | null;
          code?: string;
          exam_date?: string | null;
          detected_language?: string;
          course_digest?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['courses']['Insert']>;
        Relationships: [];
      };
      course_pdfs: {
        Row: {
          id: string;
          course_id: string;
          user_id: string;
          file_name: string;
          storage_path: string;
          extracted_summary: string | null;
          doc_category: string;
          size_bytes: number;
          extracted_topics: Json;
          gemini_file_uri: string | null;
          gemini_file_expires_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          course_id: string;
          user_id: string;
          file_name: string;
          storage_path: string;
          extracted_summary?: string | null;
          doc_category?: string;
          size_bytes?: number;
          extracted_topics?: Json;
          gemini_file_uri?: string | null;
          gemini_file_expires_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['course_pdfs']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'course_pdfs_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
        ];
      };
      levels: {
        Row: {
          id: string;
          course_id: string;
          user_id: string;
          level_number: number;
          title: string;
          description: string | null;
          relevant_pdf_names: Json;
          is_unlocked: boolean;
          best_score: number;
          cached_lesson_markdown: string | null;
          cached_questions: Json | null;
          tier: string;
          objectives: Json;
          key_formulas: Json;
          source_excerpt: string | null;
          cached_lesson: Json | null;
          lesson_doubts: Json;
          is_mastered: boolean;
          attempts: number;
          reflex_passed: number;
          feynman_best_clarity: number | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          course_id: string;
          user_id: string;
          level_number: number;
          title: string;
          description?: string | null;
          relevant_pdf_names?: Json;
          is_unlocked?: boolean;
          best_score?: number;
          cached_lesson_markdown?: string | null;
          cached_questions?: Json | null;
          tier?: string;
          objectives?: Json;
          key_formulas?: Json;
          source_excerpt?: string | null;
          cached_lesson?: Json | null;
          lesson_doubts?: Json;
          is_mastered?: boolean;
          attempts?: number;
          reflex_passed?: number;
          feynman_best_clarity?: number | null;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['levels']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'levels_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
        ];
      };
      study_attempts: {
        Row: {
          id: string;
          user_id: string;
          level_id: string;
          mode: StudyAttemptMode;
          score: number;
          elo_delta: number;
          summary: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          level_id: string;
          mode: StudyAttemptMode;
          score: number;
          elo_delta?: number;
          summary?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['study_attempts']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'study_attempts_level_id_fkey';
            columns: ['level_id'];
            isOneToOne: false;
            referencedRelation: 'levels';
            referencedColumns: ['id'];
          },
        ];
      };
      user_api_keys: {
        Row: {
          user_id: string;
          provider: 'gemini';
          encrypted_key: string;
          key_hint: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          provider?: 'gemini';
          encrypted_key: string;
          key_hint: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['user_api_keys']['Insert']>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      apply_elo_delta: {
        Args: { p_delta: number };
        Returns: number;
      };
      record_study_attempt: {
        Args: {
          p_level_id: string;
          p_mode: StudyAttemptMode;
          p_score: number;
          p_elo_delta: number;
          p_summary?: string | null;
          p_passed?: boolean | null;
          p_local_date?: string | null;
          p_apply_elo?: boolean;
        };
        Returns: Json;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
